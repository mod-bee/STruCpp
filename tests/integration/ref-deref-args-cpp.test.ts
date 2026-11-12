// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A REFERENCE TO variable passed to a parameter that is not a reference.
 * CODESYS "Data Type: REFERENCE TO": a reference is used like the variable it
 * refers to (it is dereferenced implicitly), so
 *  - a VAR_INPUT receives the referenced value;
 *  - a VAR_IN_OUT / VAR_OUTPUT receives the referenced variable, and the
 *    call's writes land in it.
 * The C++ passed the IEC_REFERENCE_TO object itself, which converts to the
 * value only through two user conversions (reference -> T -> IECVar<T>), so
 * a function call with a by-value REAL input did not build (found in the
 * modbee-utilities 0.2 FB_SettingCheck: F_CheckReal(fValue := refValue)).
 *
 * Also: a REFERENCE TO / POINTER TO STRING(n) (variable, structure field,
 * POINTER TO type alias) referred to STRING(254), whatever n, so binding a STRING(20)
 * did not build. It refers to IECString<n>.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
FUNCTION F_Twice : REAL
  VAR_INPUT fX : REAL; END_VAR
  F_Twice := fX * 2.0;
END_FUNCTION

FUNCTION F_Bump : BOOL
  VAR_IN_OUT fV : REAL; END_VAR
  fV := fV + 1.0;
  F_Bump := TRUE;
END_FUNCTION

FUNCTION F_Put : BOOL
  VAR_INPUT fX : REAL; END_VAR
  VAR_OUTPUT fOut : REAL; END_VAR
  fOut := fX;
  F_Put := TRUE;
END_FUNCTION

FUNCTION F_Len : INT
  VAR_INPUT sX : STRING(20); END_VAR
  F_Len := LEN(sX);
END_FUNCTION

FUNCTION_BLOCK FB_Deref
  VAR_INPUT
    refV : REFERENCE TO REAL;
    refS : REFERENCE TO STRING(20);
  END_VAR
  VAR_OUTPUT
    fNamed : REAL; fPos : REAL; fExpr : REAL; fMethod : REAL; nLen : INT;
  END_VAR
  VAR bX : BOOL; END_VAR
  METHOD PRIVATE Half : REAL
    VAR_INPUT fX : REAL; END_VAR
    Half := fX / 2.0;
  END_METHOD
  METHOD PRIVATE Store
    VAR_IN_OUT fV : REAL; END_VAR
    fV := fV * 10.0;
  END_METHOD
  fNamed := F_Twice(fX := refV);
  fPos := F_Twice(refV);
  fExpr := F_Twice(fX := refV) + F_Twice(refV);
  fMethod := Half(fX := refV);
  nLen := F_Len(sX := refS);
  bX := F_Bump(fV := refV);
  bX := F_Bump(refV);
  Store(fV := refV);
  bX := F_Put(fX := 7.5, fOut => refV);
END_FUNCTION_BLOCK
`;

describeIfGpp("REFERENCE TO arguments to plain parameters", () => {
  it("build and run", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'dereferenced arguments'
  VAR b : FB_Deref; v : REAL := 3.0; s : STRING(20) := 'abcd'; END_VAR
  b(refV := v, refS := s);
  ASSERT_NEAR(b.fNamed, 6.0, 0.0001);
  ASSERT_NEAR(b.fPos, 6.0, 0.0001);
  ASSERT_NEAR(b.fExpr, 12.0, 0.0001);
  ASSERT_NEAR(b.fMethod, 1.5, 0.0001);
  ASSERT_EQ(b.nLen, 4);
  ASSERT_NEAR(v, 7.5, 0.0001);
  b(refV := v, refS := s);
  ASSERT_NEAR(b.fNamed, 15.0, 0.0001);
  ASSERT_NEAR(v, 7.5, 0.0001);
END_TEST
`,
      testFileName: "test_ref_deref_args.st",
      tempDirPrefix: "strucpp-ref-deref-args-",
    });
    expect(stdout).toContain("[PASS] dereferenced arguments");
    expect(exitCode).toBe(0);
  });
});

const STRINGS = `
TYPE T_Txt : POINTER TO STRING(12); END_TYPE
TYPE ST_Txt : STRUCT refT : REFERENCE TO STRING(20); pT : POINTER TO STRING(30); END_STRUCT END_TYPE
FUNCTION_BLOCK FB_S
  VAR_INPUT refS : REFERENCE TO STRING(20); pS : POINTER TO STRING(20); END_VAR
END_FUNCTION_BLOCK
`;

describe("generated dereferences", () => {
  it("keeps a referenced STRING's length", () => {
    const result = compile(STRINGS);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.headerCode).toContain("IEC_REFERENCE_TO<IECString<20>> REFS");
    expect(result.headerCode).toContain("IEC_Ptr<IECString<20>> PS");
    expect(result.headerCode).toContain("IEC_REFERENCE_TO<IECString<20>> REFT");
    expect(result.headerCode).toContain("IEC_Ptr<IECString<30>> PT");
    expect(result.headerCode).toContain("using T_TXT = IEC_Ptr<IECString<12>>");
  });

  it("reads the value for an input, passes the variable for an in-out", () => {
    const result = compile(SOURCE);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).toContain("F_TWICE(REFV.get())");
    expect(result.cppCode).toContain("F_BUMP(REFV.target())");
    expect(result.cppCode).toContain("HALF(REFV.get())");
  });
});
