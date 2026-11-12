/**
 * A method's VAR_IN_OUT (or VAR_OUTPUT) given a shared global, and a method
 * called on a global instance with globals bound to it: each global reaches
 * the method as its own storage, never a copy, and the call runs with every
 * global it binds held (under the call lock, as a function's in-outs do). A
 * project shares a client and a node across programs this way.
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
FUNCTION_BLOCK FB_Node
  VAR_OUTPUT nHits : DINT; END_VAR
  METHOD PUBLIC Hit : DINT
    VAR_IN_OUT sTag : STRING(40); END_VAR
    nHits := nHits + 1;
    sTag := CONCAT(sTag, '+');
    Hit := nHits;
  END_METHOD
  METHOD PUBLIC Add : DINT
    VAR_INPUT n : DINT; END_VAR
    nHits := nHits + n;
    Add := nHits;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Ota
  METHOD PUBLIC Report : DINT
    VAR_IN_OUT fbNode : FB_Node; END_VAR
    VAR_OUTPUT nSeen : DINT; END_VAR
    nSeen := fbNode.Add(n := 10);
    Report := 1;
  END_METHOD
  METHOD PUBLIC Both
    VAR_IN_OUT a : FB_Node; b : FB_Node; END_VAR
    a.Add(n := 100);
    b.Add(n := 1000);
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
VAR_EXTERNAL node : FB_Node; spare : FB_Node; label : STRING(40); END_VAR
VAR ota : FB_Ota; r1, r2, seen : DINT; END_VAR
  r1 := ota.Report(fbNode := node, nSeen => seen);
  r2 := node.Hit(sTag := label);
  ota.Both(a := node, b := spare);
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL node : FB_Node; spare : FB_Node; label : STRING(40) := 'x'; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("a method binding shared globals by reference", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-mglob-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const threaded of [false, true]) {
    it(`acts on the globals themselves${threaded ? " (threaded build, with locks)" : ""}`, () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(tempDir, "main.cpp"),
        `#include "generated.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  int fails = 0;
  // Report added 10 to the global node, Hit 1, Both 100: one node, not copies.
  const long hits = (long)strucpp::NODE.read().NHITS;
  if (hits != 111) { std::printf("node hits %ld\\n", hits); ++fails; }
  if ((long)p.SEEN != 10) { std::printf("seen %ld\\n", (long)p.SEEN); ++fails; }
  if ((long)p.R2 != 11) { std::printf("r2 %ld\\n", (long)p.R2); ++fails; }
  if ((long)strucpp::SPARE.read().NHITS != 1000) { std::printf("spare\\n"); ++fails; }
  if (std::strcmp(strucpp::LABEL.read().c_str(), "x+") != 0) { std::printf("label %s\\n", strucpp::LABEL.read().c_str()); ++fails; }
  std::printf(fails ? "FAIL\\n" : "ALL_OK\\n");
  return fails;
}
`,
      );
      const bin = path.join(tempDir, threaded ? "mglob_t" : "mglob");
      execSync(
        `g++ -std=${CXX_STD} ${threaded ? "-DSTRUCPP_THREADED -pthread" : ""} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
          `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
      expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
    });
  }
});
