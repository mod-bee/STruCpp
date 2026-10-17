/**
 * SEL and MUX on STRINGs of different declared lengths. IEC 61131-3 6.6.2.5.10
 * overloads the selection functions on all data types (Table 32: SEL on ANY, MUX
 * on ANY_ELEMENTARY); STRING(32) and STRING(64) are both STRING. The generated
 * C++ did not compile ("no common type for IECStringVar<32> and
 * IECStringVar<64>"). The result is as long as the longest input, as for MAX and
 * MIN on strings; assigning it to a shorter variable truncates, as any STRING
 * assignment does.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, RUNTIME_INCLUDE_PATH, cxxEnv, CXX_STD } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
PROGRAM Main
VAR
  s32 : STRING(32) := 'short';
  t32 : STRING(32) := 'other';
  s64 : STRING(64) := 'a much longer text, well over thirty-two characters';
  r64 : STRING(64);
  r32 : STRING(32);
  g : BOOL := TRUE;
  k : INT := 1;
  ok : ARRAY[1..9] OF BOOL;
  len32 : INT;
END_VAR
  r64 := SEL(FALSE, s32, s64);  ok[1] := r64 = 'short';
  r64 := SEL(g, s32, s64);      ok[2] := r64 = s64;
  r64 := SEL(g, s64, s32);      ok[3] := r64 = 'short';
  r32 := SEL(g, s32, s64);      len32 := LEN(r32);
  ok[4] := len32 = 32;
  r64 := MUX(k, s32, s64, t32); ok[5] := r64 = s64;
  r64 := MUX(2, s32, s64, t32); ok[6] := r64 = 'other';
  r64 := MUX(7, s32, s64, t32); ok[7] := r64 = 'other';
  r32 := SEL(g, s32, t32);      ok[8] := r32 = 'other';
  r64 := SEL(g, '', s64);       ok[9] := r64 = s64;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("SEL and MUX on strings of different lengths", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-selmux-"));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("compiles, selects the input, and is as long as the longest", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const dir = path.join(tempDir, "selmux");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(dir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  int fails = 0;
  for (int i = 1; i <= 9; i++) {
    if (!(bool)p.OK[i]) { printf("FAIL ok[%d]\\n", i); ++fails; }
  }
  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return fails ? 1 : 0;
}
`,
    );
    const bin = path.join(dir, "selmux");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
        `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
