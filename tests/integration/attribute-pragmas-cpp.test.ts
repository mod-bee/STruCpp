// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Attribute pragmas `{attribute 'name'}` / `{attribute 'name' := 'value'}`
 * (CODESYS online help, "Attribute Pragmas"; IEC 61131-3 §6.2 leaves the
 * syntax and meaning of pragmas to the Implementer):
 *
 * - `qualified_only` on an enumeration ("Attribute: qualified_only"): its
 *   values are written `E.value` only, and are no bare names.
 * - `strict` on an enumeration ("Enumeration", strict programming rules): no
 *   arithmetic, and no constant or variable of another type assigned to it.
 * - `hide`, `conditionalshow` ("Attribute: hide", "Attribute:
 *   conditionalshow"): the variable is not shown in the debugger; it is still
 *   retained.
 * - Any other attribute is accepted and ignored, as CODESYS does.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const errorsOf = (src: string): string[] =>
  compile(src).errors.map((e) => e.message);

const SOURCE = `
{attribute 'qualified_only'}
{attribute 'strict'}
TYPE E_State : (Idle, Running, Fault) := Idle; END_TYPE
{attribute 'qualified_only'}
TYPE E_Other : (Idle, Done) := Idle; END_TYPE
TYPE E_Plain : (Idle, Busy) := Busy; END_TYPE
{attribute 'strict'}
TYPE E_Code : USINT (OK := 0, Bad := 7) := OK; END_TYPE

{attribute 'some_unknown_attribute' := 'any text'}
INTERFACE I_Run
  METHOD Run : INT END_METHOD
END_INTERFACE

{attribute 'reflection'}
FUNCTION_BLOCK FB_X IMPLEMENTS I_Run
  VAR_INPUT
    {attribute 'hide'}
    xHidden : BOOL;
    xShown : BOOL;
  END_VAR
  {attribute 'conditionalshow' := 'Library_Developer'}
  VAR
    n : INT;
  END_VAR
  {attribute 'call_after_init'}
  METHOD PUBLIC Run : INT
    n := n + 1;
    Run := n;
  END_METHOD
  {attribute 'monitoring' := 'call'}
  PROPERTY PUBLIC Count : INT
    GET Count := n; END_GET
  END_PROPERTY
END_FUNCTION_BLOCK

{attribute 'no_check'}
FUNCTION F_States : INT
  VAR
    s : E_State := E_State.Running;
    o : E_Other := E_Other.Done;
    p : E_Plain := Idle;            (* the bare name is E_Plain's *)
    c : E_Code := E_Code.Bad;
    n : USINT;
    f : FB_X;
  END_VAR
  CASE s OF
    E_State.Running: F_States := 1;
  END_CASE
  IF o = E_Other.Done THEN F_States := F_States + 10; END_IF
  IF p = E_Plain.Idle THEN F_States := F_States + 100; END_IF
  n := c;                           (* a strict value still reads as its base *)
  IF c = 7 THEN F_States := F_States + USINT_TO_INT(n) * 1000; END_IF
  f.Run(); f.Run();
  F_States := F_States + f.Count * 10000;
END_FUNCTION
`;

describeIfGpp("attribute pragmas at run time", () => {
  it("builds and runs a program decorated with attributes", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'attributes'
  ASSERT_EQ(F_States(), 27111);
END_TEST
`,
      testFileName: "test_attributes.st",
      tempDirPrefix: "strucpp-attributes-",
    });
    expect(stdout).toContain("[PASS] attributes");
    expect(exitCode).toBe(0);
  });
});

describe("attribute pragma rules", () => {
  it("accepts the program", () => {
    expect(errorsOf(SOURCE)).toEqual([]);
  });

  it("qualified_only: a bare value is refused, in a body and an initial value", () => {
    expect(
      errorsOf(`
{attribute 'qualified_only'}
TYPE E_State : (Idle, Running) := Idle; END_TYPE
PROGRAM P
  VAR s : E_State := Running; n : INT; END_VAR
  s := Idle;
  CASE s OF Running: n := 1; END_CASE
END_PROGRAM
`),
    ).toEqual([
      "'IDLE' is a value of 'E_STATE', declared {attribute 'qualified_only'}: write 'E_STATE.IDLE'",
      "'RUNNING' is a value of 'E_STATE', declared {attribute 'qualified_only'}: write 'E_STATE.RUNNING'",
      "'RUNNING' is a value of 'E_STATE', declared {attribute 'qualified_only'}: write 'E_STATE.RUNNING'",
    ]);
  });

  it("strict: no arithmetic, no other constant or variable assigned", () => {
    expect(
      errorsOf(`
{attribute 'strict'}
TYPE E_Code : USINT (OK := 0, Bad := 7) := OK; END_TYPE
PROGRAM P
  VAR c : E_Code; n : USINT; i : INT; END_VAR
  c := 7;
  c := n;
  c := c + 1;
  FOR c := E_Code.OK TO E_Code.Bad DO i := i + 1; END_FOR
  n := c;
  IF c = 7 THEN i := 0; END_IF
END_PROGRAM
`),
    ).toEqual([
      "Cannot assign INT to E_CODE",
      "Cannot assign USINT to E_CODE",
      "Operator '+' is not defined for the enumeration E_CODE: IEC 61131-3 Table 38 admits only SEL, MUX, EQ and NE",
      "FOR control variable 'C' must be an integer type, got E_CODE",
    ]);
  });

  it("without strict, a data type with named values still computes as its base", () => {
    expect(
      errorsOf(`
TYPE E_Code : USINT (OK := 0, Bad := 7) := OK; END_TYPE
PROGRAM P
  VAR c : E_Code; n : USINT; END_VAR
  c := 7;
  c := n;
  c := c + 1;
END_PROGRAM
`),
    ).toEqual([]);
  });

  it("hide / conditionalshow: not in the debug map, still retained", () => {
    const result = compile(`
FUNCTION_BLOCK FB_H
  VAR_INPUT
    {attribute 'hide'}
    xHidden : BOOL;
    xShown : BOOL;
  END_VAR
  VAR RETAIN
    {attribute 'conditionalshow'}
    nKept : INT;
  END_VAR
END_FUNCTION_BLOCK
PROGRAM P
  VAR
    f : FB_H;
    {attribute 'hide'}
    nSecret : INT;
    nPublic : INT;
  END_VAR
END_PROGRAM
CONFIGURATION C
  {attribute 'hide'}
  VAR_GLOBAL gHidden : INT; END_VAR
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION
`);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const paths = (result.debugMap?.leaves ?? []).map((l) => l.path);
    expect(paths).toContain("I.F.XSHOWN");
    expect(paths).toContain("I.NPUBLIC");
    expect(paths).not.toContain("I.F.XHIDDEN");
    expect(paths).not.toContain("I.NSECRET");
    // A retained hidden variable keeps its leaf: retention is not given up.
    expect(paths).toContain("I.F.NKEPT");
    expect(result.debugMap?.retainVars?.map((r) => r.path)).toContain(
      "I.F.NKEPT",
    );
  });
});
