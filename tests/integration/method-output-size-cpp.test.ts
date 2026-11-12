/**
 * Code size of a method call that omits its outputs: the same at every call
 * site as a call to a method with no outputs, however big the outputs are
 * (a STRING(64), a STRING(16), a TIME). The omitted outputs are built once,
 * inside the method, not at each call. Measured with g++ -Os on the run() of
 * a program with one call and one with nine.
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

const calls = (method: string, n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `  r := e.${method}(nId := ${i + 1});`,
  ).join("\n");

const program = (name: string, method: string, n: number): string => `
PROGRAM ${name}
VAR e : Eng; r : DINT; END_VAR
${calls(method, n)}
END_PROGRAM`;

const SOURCE = `
FUNCTION_BLOCK Eng
  VAR nCalls : DINT; END_VAR
  METHOD PUBLIC Outs : DINT
    VAR_INPUT nId : DINT; END_VAR
    VAR_OUTPUT sText : STRING(64); sTag : STRING(16); tAge : TIME; nCount : DINT; END_VAR
    nCalls := nCalls + 1;
    sText := 'served';
    sTag := 'tag';
    tAge := T#1s;
    nCount := nCalls;
    Outs := nId;
  END_METHOD
  METHOD PUBLIC Plain : DINT
    VAR_INPUT nId : DINT; END_VAR
    nCalls := nCalls + 1;
    Plain := nId;
  END_METHOD
END_FUNCTION_BLOCK
${program("P_OUTS_1", "Outs", 1)}
${program("P_OUTS_9", "Outs", 9)}
${program("P_PLAIN_1", "Plain", 1)}
${program("P_PLAIN_9", "Plain", 9)}`;

describeIfGpp("the code size of a call that omits outputs", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-msize-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("is a call's own size: the omitted outputs cost nothing per call site", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    const obj = path.join(tempDir, "generated.o");
    execSync(
      `g++ -std=${CXX_STD} -Os -ffunction-sections -c -w -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" ` +
        `-o "${obj}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    const nm = execSync(`nm -C -S "${obj}"`, {
      encoding: "utf-8",
      env: cxxEnv,
    });
    const size = (prog: string): number => {
      const line = nm
        .split("\n")
        .find((l) => l.includes(`Program_${prog}::run()`));
      expect(line, prog).toBeDefined();
      return parseInt(line!.trim().split(/\s+/)[1]!, 16);
    };
    const perOuts = (size("P_OUTS_9") - size("P_OUTS_1")) / 8;
    const perPlain = (size("P_PLAIN_9") - size("P_PLAIN_1")) / 8;
    // Four null pointers more per call, a few instructions at most.
    expect(perOuts - perPlain).toBeLessThanOrEqual(16);
  });
});
