/**
 * Per-task "stop the PLC when stuck" and stack size:
 * `TASK t(...) {CORE := 0, STOP_ON_STUCK := FALSE, STACK := 16384};`.
 *
 * Like the core (task-core-pragma.test.ts), these are an IEC 61131-3 §6.2
 * pragma after the task's parameter list (a pragma's syntax and meaning are
 * the Implementer's), so the ST stays IEC. TaskInstance is unchanged; each
 * setting is exported as its own extern "C" function, emitted only when some
 * task uses that key, so a project without them compiles to the C++ it did.
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

const PLAIN = `
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0);
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1);`;

const CORE_ONLY = `
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0);
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1) {CORE := 1};`;

const ALL = `
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0) {STACK := 8192};
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1) {CORE := 0, STOP_ON_STUCK := FALSE, STACK := 16384};`;

const errors = (r: { errors: { message: string }[] }) => r.errors.map((e) => e.message).join('\n');

describe('TASK settings pragma', () => {
  it('emits neither symbol for a project without the settings', () => {
    for (const tasks of [PLAIN, CORE_ONLY]) {
      const result = compile(config(tasks));
      expect(result.success).toBe(true);
      for (const code of [result.cppCode, result.headerCode]) {
        expect(code).not.toContain('strucpp_task_stop_on_stuck');
        expect(code).not.toContain('strucpp_task_stack');
      }
    }
  });

  it('leaves a core-only project exactly as the core alone made it', () => {
    const coreOnly = compile(config(CORE_ONLY));
    const withSettings = compile(config(ALL));
    expect(coreOnly.cppCode).toContain('// Task CPU cores');
    // The same TaskInstance table with or without the settings.
    const tasks = (cpp: string) => cpp.split('\n').filter((l) => l.includes('TaskInstance(')).join('\n');
    expect(tasks(withSettings.cppCode)).toBe(tasks(coreOnly.cppCode));
    expect(coreOnly.cppCode).toContain('cores[2] = {-1, 1};');
    expect(withSettings.cppCode).toContain('cores[2] = {-1, 0};');
  });

  it('emits each symbol only when a task uses its key', () => {
    const stuck = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0);
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1) {STOP_ON_STUCK := FALSE};`));
    expect(stuck.success).toBe(true);
    expect(stuck.cppCode).toContain('strucpp_task_stop_on_stuck');
    expect(stuck.cppCode).not.toContain('strucpp_task_stack');
    expect(stuck.cppCode).not.toContain('strucpp_task_core');

    const stack = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0) {STACK := 8192};
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1);`));
    expect(stack.success).toBe(true);
    expect(stack.cppCode).toContain('strucpp_task_stack');
    expect(stack.cppCode).not.toContain('strucpp_task_stop_on_stuck');
    expect(stack.cppCode).not.toContain('strucpp_task_core');
  });

  it('accepts the keys in any order, spacing and case, in one pragma or several', () => {
    const result = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0){ stack:=4096 ,core:=1 }{Stop_On_Stuck := false};
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1)
        {STOP_ON_STUCK := TRUE}
      ;`));
    expect(errors(result)).toBe('');
    expect(result.success).toBe(true);
    expect(result.cppCode).toContain('strucpp_task_core');
    expect(result.cppCode).toContain('strucpp_task_stop_on_stuck');
    expect(result.cppCode).toContain('strucpp_task_stack');
  });

  it.each([
    ['STOP_ON_STUCK as a number', '{STOP_ON_STUCK := 0}'],
    ['STOP_ON_STUCK as a name', '{STOP_ON_STUCK := maybe}'],
    ['STOP_ON_STUCK with no value', '{STOP_ON_STUCK := }'],
    ['a zero stack', '{STACK := 0}'],
    ['a stack below 1024 bytes', '{STACK := 512}'],
    ['a stack past 64 MiB', '{STACK := 67108865}'],
    ['a negative stack', '{STACK := -1}'],
    ['a fractional stack', '{STACK := 1.5}'],
    ['a stack given as a name', '{STACK := big}'],
    ['an unknown key beside a good one', '{CORE := 0, PRIO := 1}'],
    ['a missing assignment', '{STACK 8192}'],
    ['a key given twice in one pragma', '{STACK := 8192, STACK := 4096}'],
    ['a key given twice in two pragmas', '{STOP_ON_STUCK := FALSE} {STOP_ON_STUCK := TRUE}'],
  ])('refuses %s, naming the task', (_what, pragma) => {
    const result = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0);
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1) ${pragma};`));
    expect(result.success).toBe(false);
    expect(errors(result)).toMatch(/SLOW|slow/);
  });

  it('accepts the smallest and largest stack', () => {
    for (const n of [1024, 67108864]) {
      const result = compile(config(`
      TASK fast(INTERVAL := T#10ms, PRIORITY := 0) {STACK := ${n}};
      TASK slow(INTERVAL := T#50ms, PRIORITY := 1);`));
      expect(result.success).toBe(true);
    }
  });

  it('refuses task settings in more than one configuration', () => {
    const result = compile(`${program}
  CONFIGURATION A
    RESOURCE R ON PLC
      TASK t(INTERVAL := T#10ms, PRIORITY := 0) {STACK := 8192};
      PROGRAM a WITH t : Main;
    END_RESOURCE
  END_CONFIGURATION
  CONFIGURATION B
    RESOURCE R ON PLC
      TASK t(INTERVAL := T#10ms, PRIORITY := 0) {STOP_ON_STUCK := FALSE};
      PROGRAM a WITH t : Main;
    END_RESOURCE
  END_CONFIGURATION
`);
    expect(result.success).toBe(false);
    expect(errors(result)).toMatch(/one configuration only/);
  });
});

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp('TASK settings pragma, compiled', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strucpp-task-settings-'));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports each task setting by resource and task index, the defaults elsewhere', () => {
    const second = `
    RESOURCE Res2 ON PLC
      TASK other(INTERVAL := T#20ms, PRIORITY := 0) {STOP_ON_STUCK := FALSE};
      PROGRAM c WITH other : Main;
    END_RESOURCE`;
    const result = compile(config(ALL, second), { headerFileName: 'generated.hpp' });
    expect(result.success).toBe(true);
    fs.writeFileSync(path.join(tempDir, 'generated.hpp'), result.headerCode);
    fs.writeFileSync(path.join(tempDir, 'generated.cpp'), result.cppCode);
    fs.writeFileSync(
      path.join(tempDir, 'main.cpp'),
      `#include <cstdint>
#include <cstdio>
extern "C" int32_t strucpp_task_core(uint32_t resource, uint32_t task);
extern "C" int32_t strucpp_task_stop_on_stuck(uint32_t resource, uint32_t task);
extern "C" uint32_t strucpp_task_stack(uint32_t resource, uint32_t task);
int main() {
  std::printf("core %d %d %d\\n", strucpp_task_core(0, 0), strucpp_task_core(0, 1), strucpp_task_core(1, 0));
  std::printf("stop %d %d %d %d %d\\n", strucpp_task_stop_on_stuck(0, 0), strucpp_task_stop_on_stuck(0, 1),
              strucpp_task_stop_on_stuck(1, 0), strucpp_task_stop_on_stuck(0, 2), strucpp_task_stop_on_stuck(2, 0));
  std::printf("stack %u %u %u %u %u\\n", strucpp_task_stack(0, 0), strucpp_task_stack(0, 1),
              strucpp_task_stack(1, 0), strucpp_task_stack(0, 2), strucpp_task_stack(2, 0));
  return 0;
}
`,
    );
    const exe = path.join(tempDir, 'settings');
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" "${path.join(tempDir, 'generated.cpp')}" "${path.join(tempDir, 'main.cpp')}" -o "${exe}"`,
      { stdio: 'pipe' },
    );
    expect(execSync(`"${exe}"`).toString().trim().split('\n')).toEqual([
      'core -1 0 -1',
      'stop 1 0 0 1 1',
      'stack 8192 16384 0 0 0',
    ]);
  });
});
