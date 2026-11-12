/**
 * Ordering of character strings (IEC 61131-3 Table 29: <, <=, >, >= on
 * strings) in every form an operand takes, and a FUNCTION's VAR_IN_OUT array
 * of STRING(n).
 *
 * The runtime ordered a string variable only against another, and not with
 * <= / >=, so `ch >= 'A'` did not compile, and two literals compared as C++
 * addresses. An in-out ARRAY OF STRING(160) lost its length and refused the
 * caller's array.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
FUNCTION Fill : INT
  VAR_IN_OUT lines : ARRAY[1..4] OF STRING(160); END_VAR
  lines[2] := 'second';
  Fill := 4;
END_FUNCTION

PROGRAM Main
VAR
  ch : STRING(1) := 'Q';
  s : STRING := 'abc';
  t : STRING(10) := 'abd';
  w : WSTRING := "bc";
  msgs : ARRAY[1..4] OF STRING(160);
  upper, lt, le, gt, ge, lit_gt, lit_lt, lit_eq, lit_ne, vv_le, vv_ge, w_lt, w_ge : BOOL;
  n : INT;
END_VAR
  upper := ch >= 'A' AND ch <= 'Z';
  lt := s < 'abd';
  le := 'abc' <= s;
  gt := t > s;
  ge := s >= 'abd';
  lit_gt := 'b' > 'a';
  lit_lt := 'b' < 'a';
  lit_eq := 'same' = 'same';
  lit_ne := 'same' <> 'same';
  vv_le := s <= t;
  vv_ge := s >= t;
  w_lt := w < "bd";
  w_ge := "a" >= w;
  n := Fill(lines := msgs);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const CHECKS: Array<[string, number]> = [
  ["UPPER", 1], ["LT", 1], ["LE", 1], ["GT", 1], ["GE", 0], ["LIT_GT", 1], ["LIT_LT", 0],
  ["LIT_EQ", 1], ["LIT_NE", 0], ["VV_LE", 1], ["VV_GE", 0], ["W_LT", 1], ["W_GE", 0], ["N", 4],
];

describeIfGpp("string ordering and an in-out array of STRING(n)", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strord-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("compares by character code in every form, and passes the array", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.headerCode).toContain("Array1D<IECStringVar<160>, 1, 4>& LINES");
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    const checks = CHECKS.map(
      ([name, want]) =>
        `  if ((int)p.${name} != ${want}) { std::printf("FAIL ${name}=%d\\n", (int)p.${name}); ++fails; }`,
    ).join("\n");
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
#include <string>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  int fails = 0;
${checks}
  if (std::string(p.MSGS[2].c_str()) != "second") { std::printf("FAIL MSGS\\n"); ++fails; }
  std::printf(fails ? "FAILURES\\n" : "ALL_OK\\n");
  return fails;
}
`,
    );
    const bin = path.join(tempDir, "strord");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
