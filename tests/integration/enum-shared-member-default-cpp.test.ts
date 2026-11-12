/**
 * Two enumerations may name a member alike (`E_State.Idle`, `E_Bridge.Idle`),
 * the usual shape when values are always written qualified. A type's own
 * default (`TYPE E_State : (Idle, Busy) := Idle;`) was copied onto each
 * declaration bare, and a bare `Idle` names no single type, so the C++ read
 * `IDLE` and did not compile. The default now carries its type.
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
TYPE E_State : (Idle, Busy) := Busy; END_TYPE
TYPE E_Bridge : (Up, Idle) := Idle; END_TYPE

FUNCTION_BLOCK FB_A
  VAR_OUTPUT eState : E_State; eBridge : E_Bridge; END_VAR
END_FUNCTION_BLOCK

PROGRAM Main
VAR a : FB_A; eState : E_State; eBridge : E_Bridge; nState, nBridge, nA, nB : INT; END_VAR
  a();
  nState := TO_INT(eState); nBridge := TO_INT(eBridge);
  nA := TO_INT(a.eState); nB := TO_INT(a.eBridge);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("an enumeration's default when another enumeration shares its member names", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumdef-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("starts every declaration at its own type's default", () => {
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
  // E_State.Busy is 1; E_Bridge.Idle is 1.
  bool ok = p.NSTATE == 1 && p.NBRIDGE == 1 && p.NA == 1 && p.NB == 1;
  std::printf(ok ? "ALL_OK\\n" : "FAIL %d %d %d %d\\n", (int)p.NSTATE, (int)p.NBRIDGE, (int)p.NA, (int)p.NB);
  return ok ? 0 : 1;
}
`,
    );
    const bin = path.join(tempDir, "enumdef");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
