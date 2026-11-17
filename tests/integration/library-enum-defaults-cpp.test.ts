/**
 * Enumeration defaults that reach a call site from a LIBRARY (.stlib): an omitted FUNCTION input, an
 * omitted METHOD input, a library block's inputs, a struct default with an enumeration member, and a
 * library's GLOBALs. Found 2026-11-18 in v0.8.0-modbee.1: `F_UnitConv(fIn := 5.0)` with
 * `eFromUnit : E_Unit;` (the type's default `None`) came out as `F_UNITCONV(5.0, NONE, NONE)`, a g++
 * error ("'NONE' was not declared"), because the manifest records the default as written and the
 * consumer inserted it unqualified. Compiled from source the same call is `E_UNIT::NONE`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, RUNTIME_INCLUDE_PATH, cxxEnv, CXX_STD } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const LIB = `
TYPE
  {attribute 'qualified_only'}
  {attribute 'strict'}
  E_Unit : (None, Bar, KPa) := None;
  E_Mode2 : (Off, Low, High) := Low;
  ST_Cfg : STRUCT
    eU : E_Unit := E_Unit.KPa;
    n : INT := 3;
  END_STRUCT;
END_TYPE

VAR_GLOBAL
  gUnit : E_Unit := E_Unit.KPa;
  gUnit2 : E_Unit;
  gMode : E_Mode2;
END_VAR

FUNCTION F_Code : INT
  VAR_INPUT e : E_Unit; END_VAR
  CASE e OF
    E_Unit.Bar: F_Code := 1;
    E_Unit.KPa: F_Code := 2;
  ELSE
    F_Code := 0;
  END_CASE;
END_FUNCTION

FUNCTION F_MCode : INT
  VAR_INPUT m : E_Mode2; END_VAR
  CASE m OF
    Low: F_MCode := 1;
    High: F_MCode := 2;
  ELSE
    F_MCode := 0;
  END_CASE;
END_FUNCTION

FUNCTION F_UnitConv : DINT
  VAR_INPUT
    fIn : REAL;
    eFromUnit : E_Unit;
    eToUnit : E_Unit;
  END_VAR
  F_UnitConv := REAL_TO_DINT(fIn) * 100 + INT_TO_DINT(F_Code(e := eFromUnit) * 10 + F_Code(e := eToUnit));
END_FUNCTION

FUNCTION F_Explicit : DINT
  VAR_INPUT
    a : E_Unit := E_Unit.Bar;
    b : E_Unit := E_Unit#KPa;
    m : E_Mode2 := High;
    m2 : E_Mode2;
  END_VAR
  F_Explicit := INT_TO_DINT(F_Code(e := a) * 1000 + F_Code(e := b) * 100 + F_MCode(m := m) * 10 + F_MCode(m := m2));
END_FUNCTION

FUNCTION F_Struct : DINT
  VAR_INPUT
    st : ST_Cfg := (n := 4);          // eU: the struct's own default
    stX : ST_Cfg := (eU := E_Unit.Bar);
  END_VAR
  F_Struct := INT_TO_DINT(F_Code(e := st.eU) * 10 + F_Code(e := stX.eU));
END_FUNCTION

FUNCTION_BLOCK FB_Conv
  VAR_INPUT
    eIn : E_Unit;
    eIn2 : E_Unit := E_Unit.Bar;
  END_VAR
  VAR_OUTPUT
    nOut : INT;
  END_VAR
  METHOD PUBLIC Conv : DINT
    VAR_INPUT
      eU : E_Unit;
      eV : E_Unit := E_Unit.KPa;
      eW : E_Unit;
    END_VAR
    Conv := INT_TO_DINT(F_Code(e := eU) * 100 + F_Code(e := eV) * 10 + F_Code(e := eW));
  END_METHOD
  METHOD PUBLIC ConvM : INT
    VAR_INPUT
      mM : E_Mode2;                   // the type's default is Low, not its first value
    END_VAR
    ConvM := F_MCode(m := mM);
  END_METHOD
  nOut := F_Code(e := eIn) * 10 + F_Code(e := eIn2);
END_FUNCTION_BLOCK
`;

const SOURCE = `
PROGRAM P
  VAR
    r1 : DINT; r2 : DINT; r3 : DINT; r4 : DINT; r5 : INT; r6 : INT; r7 : INT;
    fb : FB_Conv;
  END_VAR
  r1 := F_UnitConv(fIn := 5.0);
  r2 := F_Explicit();
  r3 := F_Struct();
  r4 := fb.Conv(eU := E_Unit.Bar);
  r7 := fb.ConvM();
  fb();
  r5 := fb.nOut;
  r6 := F_Code(e := gUnit) * 100 + F_Code(e := gUnit2) * 10 + F_MCode(m := gMode);
END_PROGRAM

CONFIGURATION C
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION`;

const EXPECT: Array<[string, number]> = [
  ["R1", 500],   // 5.0 -> 500, None, None
  ["R2", 1221],  // Bar, KPa, High, Low (E_Mode2's type default)
  ["R3", 21],    // ST_Cfg's own default KPa; the input's default Bar
  ["R4", 120],   // Bar given, KPa default, None (type default)
  ["R5", 1],     // the block's inputs: None (type default), Bar
  ["R6", 201],   // GLOBALs: KPa, None, Low
  ["R7", 1],     // a METHOD input: E_Mode2's type default Low
];

describeIfGpp("enumeration defaults from a library reach every call site qualified", () => {
  let tempDir: string;
  let archive: StlibArchive;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libenumdef-"));
    const built = compileStlib([{ fileName: "units.st", source: LIB }], {
      name: "units-lib",
      version: "1.0.0",
      namespace: "unitslib",
    });
    expect(built.errors).toEqual([]);
    // through JSON, as an archive read from disk
    archive = JSON.parse(JSON.stringify(built.archive)) as StlibArchive;
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("records an enumeration type's default as written (the manifest shape is unchanged)", () => {
    // The consumer resolves it against the input's type, so archives built before the fix work as they are.
    const fn = archive.manifest.functions.find((f) => f.name.toUpperCase() === "F_UNITCONV")!;
    const p = fn.parameters.find((q) => q.name.toUpperCase() === "EFROMUNIT")!;
    expect(p.initialValue).toBe("None");
  });

  it("compiles and runs with every default in place", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp", libraries: [archive] });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).not.toMatch(/\(5\.0f?, NONE, NONE\)/);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    const checks = EXPECT.map(
      ([n, v]) =>
        `  if ((long)g_config.I.${n} != ${v}L) { std::printf("${n}: %ld want ${v}\\n", (long)g_config.I.${n}); ++fails; }`,
    ).join("\n");
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_C g_config;
int main() {
  g_config.I.run();
  int fails = 0;
${checks}
  std::printf(fails ? "FAIL\\n" : "ALL_OK\\n");
  return fails;
}
`,
    );
    const bin = path.join(tempDir, "libenumdef");
    let out = "";
    try {
      execSync(
        `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
          `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}" 2>&1`,
        { encoding: "utf-8", env: cxxEnv },
      );
      out = execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? e).slice(0, 3000);
    }
    expect(out).toBe("ALL_OK");
  });
});
