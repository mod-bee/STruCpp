/**
 * A method nothing calls costs no flash: the methods of a block nothing can
 * extend are ordinary member functions, which the linker drops when unused
 * (-ffunction-sections, --gc-sections, as the board builds link). As virtual
 * functions every method of an instantiated block was kept through its vtable.
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
FUNCTION_BLOCK Counter
  VAR n : DINT; END_VAR
  METHOD PUBLIC Used : DINT
    n := n + 1;
    Used := n;
  END_METHOD
  METHOD PUBLIC NeverCalled : DINT
    n := n * 7 + 3;
    NeverCalled := n;
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
VAR c : Counter; r : DINT; END_VAR
  r := c.Used();
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("a method nothing calls", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strip-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("is dropped by the linker, and the method called still runs", () => {
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
  p.run();
  std::printf(p.R == 2 ? "ALL_OK\\n" : "FAIL r=%d\\n", (int)p.R);
  return p.R == 2 ? 0 : 1;
}
`,
    );
    const bin = path.join(tempDir, "strip");
    execSync(
      `g++ -std=${CXX_STD} -O1 -ffunction-sections -fdata-sections -Wl,--gc-sections ` +
        `-I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
    const symbols = execSync(`nm -C "${bin}"`, { encoding: "utf-8" });
    expect(symbols).toContain("COUNTER::USED");
    expect(symbols).not.toContain("COUNTER::NEVERCALLED");
  });
});
