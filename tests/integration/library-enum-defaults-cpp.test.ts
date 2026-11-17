/**
 * (release-0.7: 0.7.0-modbee.4 recorded a type's default qualified, `E_UNIT#NONE`, so the FUNCTION
 * case below worked; it dropped `E.v` and struct-literal defaults, ignored every default of a library
 * METHOD (an omitted input got its type's zero value) and refused a library GLOBAL of an enumeration
 * passed to the library's own function. Each is a case here.)
 *
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
  VAR CONSTANT
    cPort : INT := 1883;
  END_VAR
  METHOD PUBLIC Conv : DINT
    VAR_INPUT
      eU : E_Unit;
      eV : E_Unit := E_Unit.KPa;
      eW : E_Unit;
    END_VAR
    Conv := INT_TO_DINT(F_Code(e := eU) * 100 + F_Code(e := eV) * 10 + F_Code(e := eW));
  END_METHOD
  METHOD PUBLIC Port : INT
    VAR_INPUT
      nPort : INT := cPort + 1;      // names the block's constant
    END_VAR
    Port := nPort;
  END_METHOD
  METHOD PUBLIC Scaled : REAL
    VAR_INPUT
      fK : REAL := -1.0;
    END_VAR
    Scaled := fK;
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
    r1 : DINT; r2 : DINT; r3 : DINT; r4 : DINT; r5 : INT; r6 : INT; r7 : INT; r8 : INT; r9 : REAL;
    fb : FB_Conv;
  END_VAR
  r1 := F_UnitConv(fIn := 5.0);
  r2 := F_Explicit();
  r3 := F_Struct();
  r4 := fb.Conv(eU := E_Unit.Bar);
  r7 := fb.ConvM();
  r8 := fb.Port();
  r9 := fb.Scaled();
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
  ["R8", 1884],  // a METHOD default naming the block's constant
  ["R9", -1],    // a METHOD's REAL default
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

  it("records every default (0.7 keeps its qualified type default)", () => {
    const fn = archive.manifest.functions.find((f) => f.name.toUpperCase() === "F_UNITCONV")!;
    const p = fn.parameters.find((q) => q.name.toUpperCase() === "EFROMUNIT")!;
    expect(p.initialValue).toBe("E_UNIT#NONE");
    const ex = archive.manifest.functions.find((f) => f.name.toUpperCase() === "F_EXPLICIT")!;
    expect(ex.parameters.find((q) => q.name === "A")!.initialValue).toMatch(/^E_UNIT\.BAR$/i);
    const st = archive.manifest.functions.find((f) => f.name.toUpperCase() === "F_STRUCT")!;
    expect(st.parameters.find((q) => q.name === "STX")!.initialValue).toMatch(/^\(EU := E_UNIT\.BAR\)$/i);
    const fb = archive.manifest.functionBlocks.find((b) => b.name.toUpperCase() === "FB_CONV")!;
    expect(fb.locals?.find((l) => l.name === "CPORT")).toMatchObject({ readOnly: true, initialValue: "1883" });
    const port = fb.methods!.find((m) => m.name === "PORT")!;
    // 0.7's analyzer folds the block's constant in place; the consumer also resolves it by name
    expect(port.inputs[0]!.initialValue).toMatch(/^(CPORT|1883) \+ 1$/i);
  });

  it("refuses a call omitting a METHOD input whose default reads a variable of the block", () => {
    const lib = compileStlib(
      [
        {
          fileName: "k.st",
          source: `FUNCTION_BLOCK FB_K
            VAR nLimit : INT := 5; END_VAR
            METHOD PUBLIC Cap : INT
              VAR_INPUT n : INT := nLimit; END_VAR
              Cap := n;
            END_METHOD
          END_FUNCTION_BLOCK`,
        },
      ],
      { name: "k-lib", version: "1.0.0", namespace: "klib" },
    );
    expect(lib.errors).toEqual([]);
    const k = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    const r = compile(
      `PROGRAM P VAR k : FB_K; a : INT; b : INT; END_VAR a := k.Cap(); b := k.Cap(n := 2); END_PROGRAM`,
      { libraries: [k] },
    );
    expect(r.errors.map((e) => e.message)).toEqual(["'CAP' is missing input 'N': its default is not constant"]);
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
