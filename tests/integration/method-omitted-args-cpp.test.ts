/**
 * A formal method call may omit inputs and outputs (IEC 61131-3 6.6.1.4.2):
 * an omitted input takes its declared default, an omitted output is written
 * to a temporary and dropped. A call with no arguments omits them all. The
 * generated call used to keep only the arguments written, which C++ rejects.
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
FUNCTION_BLOCK Eng
  METHOD PUBLIC Rec : INT
    VAR_INPUT A : INT := 5; B : INT := 7; END_VAR
    VAR_OUTPUT SUM : INT; AGE : TIME; END_VAR
    SUM := A + B;
    AGE := T#2s;
    Rec := A;
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
VAR e : Eng; r1, r2, r3, s2 : INT; END_VAR
  r1 := e.Rec(A := 1);
  r2 := e.Rec(B := 3, SUM => s2);
  r3 := e.Rec();
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("a method call that omits inputs and outputs", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-omit-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("takes the defaults and drops the outputs not asked for", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  int fails = 0;
  if (p.R1 != 1) { std::printf("r1 %d\\n", (int)p.R1); ++fails; }
  if (p.R2 != 5 || p.S2 != 8) { std::printf("r2 %d s2 %d\\n", (int)p.R2, (int)p.S2); ++fails; }
  if (p.R3 != 5) { std::printf("r3 %d\\n", (int)p.R3); ++fails; }
  std::printf(fails ? "FAIL\\n" : "ALL_OK\\n");
  return fails;
}
`,
    );
    const bin = path.join(tempDir, "omit");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
