// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * CODESYS operators on references (online help, "Operator: __ISVALIDREF",
 * "Operator: __QUERYINTERFACE", "Operator: __QUERYPOINTER"; extensions of
 * IEC 61131-3, whose assignment attempt `?=` §6.6.6.7 they mirror):
 *
 * - `__ISVALIDREF(r)`: TRUE when the REFERENCE TO variable r is bound.
 * - `__QUERYINTERFACE(src, dest)`: dest references the instance src refers to
 *   when it implements dest's interface, else 0; TRUE on success.
 * - `__QUERYPOINTER(src, p)`: p points at the instance src refers to.
 *
 * CODESYS requires the interfaces to extend `__SYSTEM.IQueryInterface`; here
 * every interface is queryable, and that base is accepted and ignored.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
INTERFACE I_Base EXTENDS __SYSTEM.IQueryInterface
  METHOD MBase : INT END_METHOD
END_INTERFACE
INTERFACE I_D1 EXTENDS I_Base
  METHOD M1 : INT END_METHOD
END_INTERFACE
INTERFACE I_D2 EXTENDS I_Base
  METHOD M2 : INT END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB1 IMPLEMENTS I_D1
  VAR_OUTPUT k : INT := 3; END_VAR
  METHOD PUBLIC MBase : INT MBase := 10; END_METHOD
  METHOD PUBLIC M1 : INT M1 := 11; END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB1X EXTENDS FB1
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB2 IMPLEMENTS I_D2
  METHOD PUBLIC MBase : INT MBase := 20; END_METHOD
  METHOD PUBLIC M2 : INT M2 := 22; END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_R
  VAR_INPUT x : INT; END_VAR
  VAR r : REFERENCE TO INT; END_VAR
  METHOD PUBLIC Valid : BOOL Valid := __ISVALIDREF(r); END_METHOD
  METHOD PUBLIC Bind r REF= x; END_METHOD
END_FUNCTION_BLOCK
FUNCTION F_Query : INT
  VAR
    inst1 : FB1; inst2 : FB2; instx : FB1X;
    b1 : I_Base; b2 : I_Base; d1 : I_D1; d2 : I_D2;
    p : POINTER TO FB1; n : INT;
  END_VAR
  b1 := inst1; b2 := inst2;
  IF __QUERYINTERFACE(b1, d1) THEN n := n + d1.M1(); END_IF
  IF NOT __QUERYINTERFACE(b1, d2) AND d2 = NULL THEN n := n + 100; END_IF
  IF __QUERYINTERFACE(b2, d2) THEN n := n + d2.M2() * 10; END_IF
  IF __QUERYINTERFACE(inst1, d1) THEN n := n + 1000; END_IF
  IF __QUERYPOINTER(b1, p) AND p = ADR(inst1) THEN n := n + p^.k * 10000; END_IF
  b1 := instx;
  IF __QUERYPOINTER(b1, p) AND p = ADR(instx) THEN n := n + 1; END_IF
  b1 := NULL;
  IF NOT __QUERYPOINTER(b1, p) AND p = 0 THEN n := n + 2; END_IF
  F_Query := n;
END_FUNCTION
`;

describeIfGpp("CODESYS reference operators", () => {
  it("__QUERYINTERFACE, __QUERYPOINTER and __ISVALIDREF at run time", () => {
    const test = `
TEST 'query operators'
  ASSERT_EQ(F_Query(), 31334);
END_TEST

TEST '__ISVALIDREF'
  VAR f : FB_R; END_VAR
  ASSERT_FALSE(f.Valid());
  f.Bind();
  ASSERT_TRUE(f.Valid());
END_TEST
`;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: test,
      testFileName: "test_ref_ops.st",
      tempDirPrefix: "strucpp-ref-ops-",
    });
    expect(stdout).toContain("[PASS] query operators");
    expect(stdout).toContain("[PASS] __ISVALIDREF");
    expect(exitCode).toBe(0);
  });
});

describe("CODESYS reference operator rules", () => {
  it("refuses operands of the wrong kind", () => {
    const errors = compile(`
INTERFACE I_A
END_INTERFACE
FUNCTION_BLOCK FB_N
END_FUNCTION_BLOCK
FUNCTION F : BOOL
  VAR i : INT; r : REF_TO INT; n : FB_N; a : I_A; p : POINTER TO INT; END_VAR
  F := __ISVALIDREF(i);
  F := __ISVALIDREF(r);
  F := __QUERYINTERFACE(n, a);
  F := __QUERYINTERFACE(a, i);
  F := __QUERYPOINTER(a, i);
  F := __QUERYPOINTER(a);
  F := __QUERYPOINTER(a, p);
END_FUNCTION
`).errors.map((e) => e.message);
    expect(errors).toEqual([
      "__ISVALIDREF takes a variable declared REFERENCE TO; compare a REF_TO or POINTER with NULL or 0 instead",
      "__ISVALIDREF takes a variable declared REFERENCE TO; compare a REF_TO or POINTER with NULL or 0 instead",
      "__QUERYINTERFACE: the first argument is an interface variable or an instance of a block implementing an interface",
      "__QUERYINTERFACE: the second argument is an interface variable",
      "__QUERYPOINTER: the second argument is a POINTER variable",
      "__QUERYPOINTER takes two arguments",
    ]);
  });
});
