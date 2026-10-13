/**
 * The per-task CPU core: `TASK t(...) {CORE := n};`.
 *
 * IEC 61131-3 §6.8.2 gives a TASK only SINGLE, INTERVAL and PRIORITY; §6.2 lets
 * an Implementer give pragmas `{ ... }` its own syntax and meaning, anywhere a
 * space is allowed. So the core is a pragma after the task's parameter list,
 * not new syntax, and the ST stays IEC. The editor writes it only for a task
 * the user pinned to a core; a task without one is "Auto" (the runtime's own
 * placement).
 *
 * The core does not change TaskInstance (the Linux runtime reads that array by
 * its layout). It is exported as `strucpp_task_core(resource, task)`, emitted
 * only when some task has a core, so a project without one compiles to exactly
 * the C++ it did before.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { compile } from '../../src/index.js';
import { hasGpp, CXX_STD, RUNTIME_INCLUDE_PATH } from './test-helpers.js';

const program = `
  PROGRAM Main
    VAR x : INT; END_VAR
    x := x + 1;
  END_PROGRAM
`;

function config(tasks: string, extraResource = ''): string {
  return `${program}
  CONFIGURATION Cfg
    RESOURCE Res ON PLC
${tasks}
      PROGRAM a WITH fast : Main;
      PROGRAM b WITH slow : Main;
    END_RESOURCE
${extraResource}
  END_CONFIGURATION
`;
}

const AUTO = `
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0);
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1);`;

const PINNED = `
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0);
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1) {CORE := 1};`;

describe('TASK core pragma', () => {
  it('emits nothing new for a project without a core', () => {
    const result = compile(config(AUTO));
    expect(result.success).toBe(true);
    expect(result.cppCode).not.toContain('strucpp_task_core');
    expect(result.headerCode).not.toContain('strucpp_task_core');
  });

  it('compiles a pinned task to the same TaskInstance table as an unpinned one', () => {
    const auto = compile(config(AUTO));
    const pinned = compile(config(PINNED));
    expect(pinned.success).toBe(true);
    const tasks = (cpp: string) => cpp.split('\n').filter((l) => l.includes('TaskInstance(')).join('\n');
    expect(tasks(pinned.cppCode)).toBe(tasks(auto.cppCode));
    expect(pinned.cppCode).toContain('strucpp_task_core');
  });

  it('accepts any spacing and letter case, as a pragma may', () => {
    const result = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0){ core:=0 };
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1)
        {Core := 1}
      ;`));
    expect(result.success).toBe(true);
    expect(result.cppCode).toContain('strucpp_task_core');
  });

  it.each([
    ['a negative core', '{CORE := -1}'],
    ['a name for a core', '{CORE := x}'],
    ['a missing number', '{CORE := }'],
    ['a fraction', '{CORE := 1.5}'],
  ])('refuses %s, naming the task', (_what, pragma) => {
    const result = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0);
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1) ${pragma};`));
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join('\n')).toMatch(/SLOW|slow/);
  });

  it('refuses a core given twice for one task', () => {
    const result = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0) {CORE := 0} {CORE := 1};
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1);`));
    expect(result.success).toBe(false);
  });

  it('leaves every other pragma as it was (still not accepted)', () => {
    const result = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0) {VERSION 2.0};
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1);`));
    expect(result.success).toBe(false);
  });
});

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp('TASK core pragma, compiled', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strucpp-task-core-'));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports each task core, -1 for Auto, by resource and task index', () => {
    const second = `
    RESOURCE Res2 ON PLC
      TASK other(INTERVAL := T#20ms, PRIORITY := 0) {CORE := 0};
      PROGRAM c WITH other : Main;
    END_RESOURCE`;
    const result = compile(config(PINNED, second), { headerFileName: 'generated.hpp' });
    expect(result.success).toBe(true);
    fs.writeFileSync(path.join(tempDir, 'generated.hpp'), result.headerCode);
    fs.writeFileSync(path.join(tempDir, 'generated.cpp'), result.cppCode);
    fs.writeFileSync(
      path.join(tempDir, 'main.cpp'),
      `#include <cstdint>
#include <cstdio>
extern "C" int32_t strucpp_task_core(uint32_t resource, uint32_t task);
int main() {
  std::printf("%d %d %d %d %d\\n", strucpp_task_core(0, 0), strucpp_task_core(0, 1),
              strucpp_task_core(1, 0), strucpp_task_core(1, 1), strucpp_task_core(2, 0));
  return 0;
}
`,
    );
    const exe = path.join(tempDir, 'cores');
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" "${path.join(tempDir, 'generated.cpp')}" "${path.join(tempDir, 'main.cpp')}" -o "${exe}"`,
      { stdio: 'pipe' },
    );
    expect(execSync(`"${exe}"`).toString().trim()).toBe('-1 1 0 -1 -1');
  });
});
