/**
 * A variable named like a library function (`aIn` and OSCAT's AIN; IEC names
 * ignore case) is the POU's own (IEC 61131-3 Ed.3 6.5.2.2: a POU's
 * declarations are local to it): reading it must not pull the library
 * function into the build. It did, and AIN's parameters HIGH / LOW then met
 * a board core's HIGH / LOW macros, failing deep in the library code. A real
 * call of the function still pulls it in, and a name read but declared
 * nowhere (a library's global) still does too.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const oscat = fs.existsSync(path.resolve(LIBS_DIR, "oscat-basic.stlib"));

const SHADOWS = `
FUNCTION_BLOCK FB_Io
  VAR aIn : ARRAY[1..4] OF REAL; END_VAR
  METHOD PUBLIC Read : REAL
    Read := aIn[1];
  END_METHOD
  aIn[1] := 2.0;
END_FUNCTION_BLOCK

FUNCTION F_Io : REAL
  VAR aIn : REAL; END_VAR
  aIn := 1.5;
  F_Io := aIn;
END_FUNCTION

PROGRAM P_Io
  VAR aIn : ARRAY[1..4] OF REAL; io : FB_Io; r : REAL; END_VAR
  aIn[1] := 2.0;
  io();
  r := aIn[1] + io.Read() + F_Io();
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : P_Io;
  END_RESOURCE
END_CONFIGURATION`;

const CALLS = `
PROGRAM P_Call
  VAR r : REAL; END_VAR
  r := AIN(IN := 16#FF, BITS := 8, SIGN := 255, LOW := 0.0, HIGH := 10.0);
END_PROGRAM`;

describe.skipIf(!hasGpp || !oscat)(
  "a variable named like a library function",
  () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-shadow-"));
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("does not pull the function in; it builds beside HIGH / LOW macros", () => {
      const result = compile(SHADOWS, {
        headerFileName: "generated.hpp",
        libraries: discoverStlibs(LIBS_DIR),
      });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      expect(result.headerCode).not.toMatch(/IEC_REAL AIN\(/);
      fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
      // A board core's macros, as Arduino.h defines them, in every unit.
      fs.writeFileSync(
        path.join(tempDir, "macros.h"),
        "#define HIGH 0x1\n#define LOW 0x0\n",
      );
      fs.writeFileSync(
        path.join(tempDir, "main.cpp"),
        `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  g_config.INSTANCE0.run();
  const double r = g_config.INSTANCE0.R;
  std::printf(r > 5.49 && r < 5.51 ? "ALL_OK\\n" : "FAIL %f\\n", r);
  return 0;
}
`,
      );
      const bin = path.join(tempDir, "shadow");
      execSync(
        `g++ -std=${CXX_STD} -include "${path.join(tempDir, "macros.h")}" -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
          `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
      expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
    });

    it("still pulls the function in for a real call", () => {
      const result = compile(CALLS, {
        headerFileName: "generated.hpp",
        libraries: discoverStlibs(LIBS_DIR),
      });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      expect(result.headerCode).toMatch(/IEC_REAL AIN\(/);
    });
  },
);
