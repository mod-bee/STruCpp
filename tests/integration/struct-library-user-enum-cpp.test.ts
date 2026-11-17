/**
 * A STRUCT with a member of a library's enumeration and a member of the
 * project's own enumeration. A struct holding a library type is emitted in a
 * later batch of types than the project's enumerations; that batch did not
 * know them as enumerations, so the struct lost its layout table (an ANY
 * argument of it got a null TYPEDESC and a block walking it saw no member)
 * and the project enumeration's field lost its forceable IEC_ wrapper.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const LIB = `
TYPE
  E_Power : (SwitchOff, SwitchOn, Restart) := SwitchOff;
  E_Level : UINT (Low := 10, High := 20) := Low;
END_TYPE
`;

const SOURCE = `
TYPE
  E_X : (Idle, Running);
  {attribute 'to_string'}
  E_Y : UINT (YOff := 0, YOn := 7);
  S_T : STRUCT
    m : E_Power;
    s : E_X;
    l : E_Level;
    y : E_Y;
    n : INT;
  END_STRUCT;
END_TYPE

FUNCTION F_Members : DINT
  VAR_INPUT x : ANY; END_VAR
  {external
    F_MEMBERS_result = (X.TYPEDESC == nullptr) ? -1 : static_cast<int>(X.TYPEDESC->MEMBERCOUNT);
  }
END_FUNCTION

PROGRAM P
  VAR d : S_T; r : DINT; END_VAR
  d.s := E_X.Running;
  r := F_Members(x := d);
END_PROGRAM

CONFIGURATION C
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("a struct of a library enumeration and a project one", () => {
  let tempDir: string;
  let archive: StlibArchive;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libenum-"));
    const built = compileStlib([{ fileName: "power.st", source: LIB }], {
      name: "power-lib",
      version: "1.0.0",
      namespace: "powerlib",
    });
    expect(built.errors).toEqual([]);
    archive = JSON.parse(JSON.stringify(built.archive)) as StlibArchive;
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("keeps its layout table and every member's forceable field", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      libraries: [archive],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(
      result.warnings
        .map((w) => w.message)
        .filter((m) => m.includes("no member layout")),
    ).toEqual([]);
    expect(result.headerCode).toMatch(/IEC_E_X S\b/);
    expect(result.headerCode).toMatch(/IEC_E_Y Y\b/);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_C g_config;
int main() {
  g_config.I.run();
  int fails = 0;
  if ((long)g_config.I.R != 5) { std::printf("ANY members: %ld\\n", (long)g_config.I.R); ++fails; }
  const strucpp::TypeDesc& t = strucpp::S_T__TYPEDESC;
  const char* names[] = { "m", "s", "l", "y", "n" };
  for (int k = 0; k < 5; ++k) {
    if (std::strcmp(t.MEMBERS[k].NAME, names[k]) != 0) { std::printf("member %d: %s\\n", k, t.MEMBERS[k].NAME); ++fails; }
  }
  if (t.MEMBERS[1].TYPECLASS != strucpp::TYPE_CLASS::TYPE_ENUM) { std::printf("s not TYPE_ENUM\\n"); ++fails; }
  const uint8_t* base = reinterpret_cast<const uint8_t*>(&g_config.I.D);
  const int16_t s = *reinterpret_cast<const int16_t*>(base + t.MEMBERS[1].BYTEOFFSET);
  if (s != 1) { std::printf("s at its offset: %d\\n", (int)s); ++fails; }
  std::printf(fails ? "FAIL\\n" : "ALL_OK\\n");
  return fails;
}
`,
    );
    const bin = path.join(tempDir, "libenum");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
