// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * The object-oriented features, compiled and run together the way a library
 * of equipment blocks uses them:
 *
 * - METHOD (IEC 61131-3 6.6.5.4), VAR_INST (CODESYS "Variable: VAR_INST")
 * - PROPERTY with GET / SET, also declared on an INTERFACE (CODESYS "Object:
 *   Property"; IEC 61131-3 Ed.3 has no properties)
 * - ABSTRACT block and method (6.6.5.8.2), FINAL (6.6.5.8.3), OVERRIDE
 *   (6.6.5.5.3)
 * - PUBLIC / PRIVATE / PROTECTED / INTERNAL (6.6.5.9, 6.6.5.10; INTERNAL is
 *   access within the namespace, here the compilation unit)
 * - REFERENCE TO (CODESYS "Data Type: REFERENCE TO") and REF_TO (6.4.4.10) of
 *   a structure, as a block input and a method parameter
 * - THIS / SUPER (6.6.5.7), SUPER^() body call (6.6.7.2.9), CODESYS THIS^
 * - PERSISTENT (retained here, CODESYS "Variable: PERSISTENT")
 * - EXTENDS with IMPLEMENTS (6.6.6.4, 6.6.7.2.8)
 * - ARRAY [1..n] OF an interface, walked in a loop calling a method (6.6.6.2)
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const errorsOf = (src: string): string[] =>
  compile(src).errors.map((e) => e.message);

const SOURCE = `
TYPE ST_Data : STRUCT n : INT; END_STRUCT END_TYPE

INTERFACE I_Part
  METHOD Run : INT
    VAR_INPUT bOn : BOOL; END_VAR
  END_METHOD
  PROPERTY nCount : INT END_PROPERTY
  PROPERTY bReady : BOOL GET END_GET END_PROPERTY
END_INTERFACE

INTERFACE I_Pump EXTENDS I_Part
  METHOD Speed : INT END_METHOD
END_INTERFACE

FUNCTION_BLOCK ABSTRACT FB_Equipment IMPLEMENTS I_Part
  VAR PROTECTED nRuns : INT; END_VAR
  VAR PRIVATE nSecret : INT := 7; END_VAR
  VAR INTERNAL nBody : INT; END_VAR
  METHOD PUBLIC ABSTRACT Run : INT
    VAR_INPUT bOn : BOOL; END_VAR
  END_METHOD
  PROPERTY PUBLIC nCount : INT
    GET nCount := nRuns; END_GET
    SET nRuns := nCount; END_SET
  END_PROPERTY
  PROPERTY PUBLIC bReady : BOOL
    GET bReady := nRuns > 2; END_GET
  END_PROPERTY
  METHOD PUBLIC FINAL Secret : INT
    Secret := nSecret;
  END_METHOD
  METHOD PROTECTED Bump : INT
    nRuns := nRuns + 1;
    Bump := nRuns;
  END_METHOD
  METHOD INTERNAL Answer : INT
    Answer := 42;
  END_METHOD
  METHOD PUBLIC Describe : INT
    Describe := 1;
  END_METHOD
  nBody := nBody + 1;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Pump EXTENDS FB_Equipment IMPLEMENTS I_Pump
  VAR_INPUT
    refData : REFERENCE TO ST_Data;
    pData : REF_TO ST_Data;
  END_VAR
  VAR PERSISTENT nStarts : INT; END_VAR
  METHOD PUBLIC Run : INT
    VAR_INPUT bOn : BOOL; END_VAR
    VAR_INST k : INT; END_VAR
    k := k + 1;
    IF bOn THEN THIS^.Bump(); END_IF
    Run := k + SUPER^.Secret();
  END_METHOD
  METHOD PUBLIC Speed : INT
    Speed := THIS^.nRuns * 2;
  END_METHOD
  METHOD PUBLIC OVERRIDE Describe : INT
    Describe := SUPER^.Describe() + 10;
  END_METHOD
  METHOD PUBLIC Fill
    VAR_INPUT r : REFERENCE TO ST_Data; p : REF_TO ST_Data; END_VAR
    r.n := r.n + 1;
    p^.n := p^.n + 10;
  END_METHOD
  METHOD PUBLIC Starts : INT
    Starts := nStarts * 100 + nBody;
  END_METHOD
  SUPER^();
  IF __ISVALIDREF(refData) THEN refData.n := refData.n + 100; END_IF
  IF pData <> 0 THEN pData^.n := pData^.n + 1000; END_IF
  nStarts := nStarts + 1;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FINAL FB_Valve EXTENDS FB_Equipment
  METHOD PUBLIC Run : INT
    VAR_INPUT bOn : BOOL; END_VAR
    Run := 5;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION F_Walk : INT
  VAR_INPUT n : INT; END_VAR
  VAR_IN_OUT parts : ARRAY[*] OF I_Part; END_VAR
  VAR i : INT; END_VAR
  FOR i := 1 TO n DO
    F_Walk := F_Walk + parts[i].Run(bOn := TRUE);
  END_FOR
END_FUNCTION

FUNCTION_BLOCK FB_Store
  VAR refD : REFERENCE TO ST_Data; END_VAR
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; refData : REFERENCE TO ST_Data; END_VAR
    refD REF= refData;
  END_METHOD
  METHOD PUBLIC Bump
    refD.n := refD.n + 1;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION F_Store : INT
  VAR d : ST_Data; s : FB_Store(refData := d); END_VAR
  s.Bump();
  s.Bump();
  F_Store := d.n;
END_FUNCTION

PROGRAM P
  VAR p : FB_Pump; d : ST_Data; END_VAR
  p(refData := d, pData := REF(d));
END_PROGRAM
`;

describeIfGpp("OOP end to end", () => {
  it("runs a block tree with interfaces, properties and references", () => {
    const test = `
TEST 'references as input and parameter, SUPER^() body, PERSISTENT'
  VAR p : FB_Pump; d : ST_Data; END_VAR
  p(refData := d, pData := REF(d));
  ASSERT_EQ(d.n, 1100);
  p.Fill(r := d, p := REF(d));
  ASSERT_EQ(d.n, 1111);
  p(refData := d, pData := REF(d));
  ASSERT_EQ(d.n, 2211);
  ASSERT_EQ(p.Starts(), 202);
  ASSERT_EQ(F_Store(), 2);
END_TEST

TEST 'interfaces, properties, methods and access'
  VAR
    p : FB_Pump; v : FB_Valve;
    parts : ARRAY[1..2] OF I_Part;
    ip : I_Pump;
    tot : INT;
  END_VAR
  parts[1] := p;
  parts[2] := v;
  tot := F_Walk(n := 2, parts := parts);
  ASSERT_EQ(tot, 13);
  ASSERT_FALSE(parts[1].bReady);
  parts[1].nCount := 5;
  ASSERT_EQ(parts[1].nCount, 5);
  ASSERT_TRUE(parts[1].bReady);
  ip := p;
  ASSERT_EQ(ip.Speed(), 10);
  ASSERT_EQ(ip.nCount, 5);
  ASSERT_EQ(p.Describe(), 11);
  ASSERT_EQ(v.Describe(), 1);
  ASSERT_EQ(p.Answer(), 42);
  ASSERT_EQ(p.Secret(), 7);
END_TEST
`;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: test,
      testFileName: "test_oop_e2e.st",
      tempDirPrefix: "strucpp-oop-e2e-",
    });
    expect(stdout).toContain(
      "[PASS] references as input and parameter, SUPER^() body, PERSISTENT",
    );
    expect(stdout).toContain("[PASS] interfaces, properties, methods and access");
    expect(exitCode).toBe(0);
  });
});

describe("OOP rules", () => {
  it("accepts the source", () => {
    expect(errorsOf(SOURCE)).toEqual([]);
  });

  it("retains a PERSISTENT variable", () => {
    const result = compile(`${SOURCE}
CONFIGURATION C
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION
`);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.debugMap?.retainVars?.map((r) => r.path)).toContain(
      "I.P.NSTARTS",
    );
  });

  it("refuses an ABSTRACT instance, extending FINAL, overriding a FINAL method and outside access", () => {
    expect(
      errorsOf(`${SOURCE}
FUNCTION_BLOCK FB_More EXTENDS FB_Valve
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Pump2 EXTENDS FB_Pump
  METHOD PUBLIC OVERRIDE Secret : INT
    Secret := 0;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Q
  VAR e : FB_Equipment; p : FB_Pump; k : INT; END_VAR
  k := p.nSecret;  (* PRIVATE *)
  k := p.Bump();
  k := p.nBody;    (* INTERNAL: allowed in the unit *)
END_PROGRAM
`),
    ).toEqual([
      "Cannot extend FINAL FUNCTION_BLOCK 'FB_VALVE'.",
      "Cannot override FINAL method 'SECRET' from 'FB_PUMP'.",
      "Cannot instantiate ABSTRACT FUNCTION_BLOCK 'FB_EQUIPMENT'.",
      "'P.NSECRET' is a PRIVATE variable of 'FB_EQUIPMENT' and cannot be accessed from here (IEC 61131-3 6.6.5.10)",
      "Cannot call PROTECTED method 'BUMP' of 'FB_EQUIPMENT' from 'PROGRAM'.",
    ]);
  });

  it("refuses a block missing an interface property or its SET", () => {
    expect(
      errorsOf(`
INTERFACE I_P
  PROPERTY nVal : INT END_PROPERTY
  PROPERTY bOk : BOOL GET END_GET END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_P
  PROPERTY nVal : INT
    GET nVal := 1; END_GET
  END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM P
  VAR i : I_P; b : BOOL; END_VAR
  i.bOk := b;
END_PROGRAM
`),
    ).toEqual([
      "Property 'NVAL' of 'FB_A' needs SET: INTERFACE 'I_P' declares it",
      "FUNCTION_BLOCK 'FB_A' does not implement property 'BOK' of INTERFACE 'I_P'",
      "Property 'BOK' of 'I_P' is read-only (no SET accessor).",
    ]);
  });

  it("refuses binding a REFERENCE TO input to a value or another type", () => {
    expect(
      errorsOf(`
TYPE ST_A : STRUCT n : INT; END_STRUCT END_TYPE
TYPE ST_B : STRUCT n : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_R
  VAR_INPUT r : REFERENCE TO ST_A; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
  VAR f : FB_R; b : ST_B; END_VAR
  f(r := b);
END_PROGRAM
`),
    ).toEqual([
      "Input 'R' is REFERENCE TO ST_A: the call binds it, so pass a variable of type ST_A",
    ]);
  });
});
