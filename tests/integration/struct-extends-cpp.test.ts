// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * STRUCT EXTENDS (CODESYS online help, "Data Structure: STRUCT", extension of
 * a type declaration: "In addition to its own members, the extended
 * structure also has the same structure members as the base structure";
 * `TYPE S_PENTAGON EXTENDS S_POLYGONLINE : STRUCT ... END_STRUCT END_TYPE`).
 * IEC 61131-3 Ed.3 has no structure extension.
 *
 * - The derived structure holds the base's members first; initial values of
 *   both apply; an initializer may name either.
 * - A REFERENCE TO / REF_TO the base may refer to a derived variable, as a
 *   reference to a base block may refer to a derived instance (IEC 61131-3
 *   6.4.4.10.1). A value of the derived type is not assigned to a base
 *   variable: the help page defines no such conversion.
 * - The debug table lists each member once; a library carries it.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;
const errorsOf = (src: string): string[] =>
  compile(src).errors.map((e) => e.message);

const SOURCE = `
TYPE ST_MotorSet EXTENDS ST_EquipmentSet : STRUCT
  rSpeed : REAL := 50.0;
END_STRUCT END_TYPE
TYPE ST_EquipmentSet : STRUCT
  bEnable : BOOL := TRUE;
  nMode : INT := 2;
END_STRUCT END_TYPE
TYPE ST_VsdSet EXTENDS ST_MotorSet : STRUCT
  nRamp : INT := 7;
END_STRUCT END_TYPE

FUNCTION_BLOCK FB_Equipment
  VAR_INPUT refSet : REFERENCE TO ST_EquipmentSet; END_VAR
  VAR_OUTPUT nMode : INT; END_VAR
  IF __ISVALIDREF(refSet) THEN
    nMode := refSet.nMode;
    refSet.nMode := refSet.nMode + 1;
  END_IF
END_FUNCTION_BLOCK

FUNCTION F_Struct : DINT
  VAR
    m : ST_MotorSet := (nMode := 5, rSpeed := 10.0);
    v : ST_VsdSet;
    e : FB_Equipment;
    p : REF_TO ST_EquipmentSet;
  END_VAR
  e(refSet := m);                     (* m.nMode 5 -> 6, e.nMode = 5 *)
  p := REF(v);
  p^.nMode := p^.nMode * 10;          (* v.nMode 2 -> 20 *)
  F_Struct := e.nMode * 1000000 + m.nMode * 10000 + v.nMode * 100 + v.nRamp
              + REAL_TO_DINT(m.rSpeed + v.rSpeed) * 0 + BOOL_TO_DINT(v.bEnable) * 0;
END_FUNCTION

FUNCTION F_Defaults : DINT
  VAR v : ST_VsdSet; END_VAR
  F_Defaults := BOOL_TO_DINT(v.bEnable) * 10000 + v.nMode * 1000
                + REAL_TO_DINT(v.rSpeed) * 10 + v.nRamp - 7;
END_FUNCTION
`;

describeIfGpp("STRUCT EXTENDS at run time", () => {
  it("holds the base's members, combines initial values and binds base references", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'extended structures'
  ASSERT_EQ(F_Struct(), 5062007);
  ASSERT_EQ(F_Defaults(), 12500);
END_TEST
`,
      testFileName: "test_struct_extends.st",
      tempDirPrefix: "strucpp-struct-extends-",
    });
    expect(stdout).toContain("[PASS] extended structures");
    expect(exitCode).toBe(0);
  });
});

describe("STRUCT EXTENDS rules", () => {
  it("accepts the source", () => {
    expect(errorsOf(SOURCE)).toEqual([]);
  });

  it("lists each member once in the debug table, the base's first", () => {
    const result = compile(`${SOURCE}
PROGRAM P VAR v : ST_VsdSet; END_VAR END_PROGRAM
CONFIGURATION C
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION
`);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(
      (result.debugMap?.leaves ?? [])
        .map((l) => l.path)
        .filter((p) => p.startsWith("I.V.")),
    ).toEqual(["I.V.BENABLE", "I.V.NMODE", "I.V.RSPEED", "I.V.NRAMP"]);
  });

  it("refuses a base that is no structure, a cycle, a repeated member and EXTENDS on another type", () => {
    expect(
      errorsOf(`
TYPE ST_A : STRUCT n : INT; END_STRUCT END_TYPE
TYPE ST_Bad1 EXTENDS INT : STRUCT x : INT; END_STRUCT END_TYPE
TYPE ST_C1 EXTENDS ST_C2 : STRUCT x : INT; END_STRUCT END_TYPE
TYPE ST_C2 EXTENDS ST_C1 : STRUCT y : INT; END_STRUCT END_TYPE
TYPE ST_Dup EXTENDS ST_A : STRUCT n : INT; END_STRUCT END_TYPE
TYPE E_Bad EXTENDS ST_A : (EA, EB); END_TYPE
`),
    ).toEqual([
      "STRUCT 'ST_BAD1' EXTENDS 'INT', which is not a STRUCT",
      "STRUCT 'ST_C1' EXTENDS itself through 'ST_C2'",
      "STRUCT 'ST_DUP' declares 'N', a member it inherits from 'ST_A'",
      "TYPE 'E_BAD': only a STRUCT can EXTEND another type",
    ]);
  });

  it("does not assign a derived value to a base variable", () => {
    expect(
      errorsOf(`${SOURCE}
PROGRAM Q VAR m : ST_MotorSet; b : ST_EquipmentSet; END_VAR b := m; END_PROGRAM
`).length,
    ).toBeGreaterThan(0);
  });
});

describeIfGpp("STRUCT EXTENDS in a library", () => {
  it("is in the manifest and works in a consumer, which may extend it", () => {
    const lib = compileStlib(
      [
        {
          fileName: "sets.st",
          source: `
TYPE ST_Base : STRUCT nMode : INT := 2; END_STRUCT END_TYPE
TYPE ST_LibDerived EXTENDS ST_Base : STRUCT nExtra : INT := 3; END_STRUCT END_TYPE
FUNCTION F_Mode : INT
  VAR_IN_OUT s : ST_LibDerived; END_VAR
  F_Mode := s.nMode + s.nExtra;
END_FUNCTION
`,
        },
      ],
      { name: "sets-lib", version: "1.0.0", namespace: "setslib" },
    );
    expect(lib.errors).toEqual([]);
    const archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    const entry = archive.manifest.types.find((t) => t.name === "ST_LIBDERIVED");
    expect(entry?.extends).toBe("ST_BASE");
    expect(entry?.fields?.map((f) => f.name)).toEqual(["NMODE", "NEXTRA"]);
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `
TYPE ST_Mine EXTENDS ST_Base : STRUCT nMine : INT := 40; END_STRUCT END_TYPE
FUNCTION F_Lib : INT
  VAR d : ST_LibDerived; m : ST_Mine; r : REFERENCE TO ST_Base; END_VAR
  r REF= m;
  F_Lib := F_Mode(s := d) + r.nMode + m.nMine;
END_FUNCTION
`,
      testST: `
TEST 'library extended structures'
  ASSERT_EQ(F_Lib(), 47);
END_TEST
`,
      testFileName: "test_struct_extends_lib.st",
      tempDirPrefix: "strucpp-struct-extends-lib-",
      compileOptions: { libraries: [archive] },
    });
    expect(stdout).toContain("[PASS] library extended structures");
    expect(exitCode).toBe(0);
  });
});
