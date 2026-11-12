// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Code generation of three call forms the compiler accepted and the C++ did
 * not build (the first modbee-utilities 0.2 block):
 *
 * 1. A property GET that calls a method of its block or writes a member
 *    (CODESYS "Object: Property": the accessors are methods). The getter was
 *    emitted `const`, so it could not call a (non-const) method.
 * 2. A REFERENCE TO argument passed to a REFERENCE TO parameter of the base
 *    structure (CODESYS "Data Type: REFERENCE TO", "Data Structure: STRUCT"
 *    EXTENDS): passed on unchanged, it did not convert. It binds to what it
 *    refers to.
 * 3. A REFERENCE TO parameter of a method called by its bare name, through
 *    THIS / SUPER, or of a function: the argument was passed as a value
 *    instead of being bound.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
TYPE ST_ProtectionSet : STRUCT nLimit : INT := 5; END_STRUCT END_TYPE
TYPE ST_EquipmentSet : STRUCT stOverload : ST_ProtectionSet; END_STRUCT END_TYPE
TYPE ST_EquipmentData : STRUCT nCmd : INT; set : ST_EquipmentSet; END_STRUCT END_TYPE
TYPE ST_MotorData EXTENDS ST_EquipmentData : STRUCT nSpeed : INT; END_STRUCT END_TYPE

FUNCTION F_Limit : INT
  VAR_INPUT stP : REFERENCE TO ST_ProtectionSet; END_VAR
  F_Limit := stP.nLimit;
  stP.nLimit := stP.nLimit + 1;
END_FUNCTION

FUNCTION_BLOCK FB_Equipment
  VAR_INPUT refData : REFERENCE TO ST_EquipmentData; END_VAR
  VAR nChecks : INT; nBegins : INT; END_VAR
  METHOD PROTECTED Begin : INT
    VAR_INPUT refCmd : REFERENCE TO ST_EquipmentData; refSet : REFERENCE TO ST_EquipmentSet; END_VAR
    nBegins := nBegins + 1;
    refCmd.nCmd := refCmd.nCmd + 1;
    Begin := refSet.stOverload.nLimit;
  END_METHOD
  METHOD PRIVATE ProtOk : BOOL
    VAR_INPUT stP : REFERENCE TO ST_ProtectionSet; END_VAR
    ProtOk := stP.nLimit > 0;
  END_METHOD
  METHOD PUBLIC FeedbackOk : BOOL
    nChecks := nChecks + 1;
    FeedbackOk := __ISVALIDREF(refData) AND ProtOk(stP := refData.set.stOverload);
  END_METHOD
  PROPERTY PUBLIC bIsRunning : BOOL
    GET
      bIsRunning := FeedbackOk();
    END_GET
  END_PROPERTY
  PROPERTY PUBLIC nChecked : INT
    GET
      nChecked := nChecks;
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Motor EXTENDS FB_Equipment
  VAR_INPUT refMotor : REFERENCE TO ST_MotorData; END_VAR
  VAR_OUTPUT nLimit : INT; nThis : INT; nSuper : INT; nFunc : INT; END_VAR
  nLimit := Begin(refCmd := refMotor, refSet := refMotor.set);
  nThis := THIS^.Begin(refCmd := refMotor, refSet := refMotor.set);
  nSuper := SUPER^.Begin(refCmd := refMotor, refSet := refMotor.set);
  nFunc := F_Limit(stP := refMotor.set.stOverload);
END_FUNCTION_BLOCK
`;

describeIfGpp("calls that bind references", () => {
  it("build and run", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'reference bindings'
  VAR e : FB_Equipment; m : FB_Motor; d : ST_EquipmentData; md : ST_MotorData; END_VAR
  e(refData := d);
  ASSERT_TRUE(e.bIsRunning);
  ASSERT_TRUE(e.bIsRunning);
  ASSERT_EQ(e.nChecked, 2);
  m(refData := md, refMotor := md);
  ASSERT_EQ(m.nLimit, 5);
  ASSERT_EQ(m.nThis, 5);
  ASSERT_EQ(m.nSuper, 5);
  ASSERT_EQ(m.nFunc, 5);
  ASSERT_EQ(md.set.stOverload.nLimit, 6);
  ASSERT_EQ(md.nCmd, 3);
END_TEST
`,
      testFileName: "test_ref_call_binding.st",
      tempDirPrefix: "strucpp-ref-call-binding-",
    });
    expect(stdout).toContain("[PASS] reference bindings");
    expect(exitCode).toBe(0);
  });
});

describe("generated calls", () => {
  it("emits non-const property getters and bound reference arguments", () => {
    const result = compile(SOURCE);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.headerCode).toMatch(/IEC_BOOL get_BISRUNNING\(\);/);
    expect(result.cppCode).toContain(
      "PROTOK(IEC_REFERENCE_TO<ST_PROTECTIONSET>(*&REFDATA.target().SET.STOVERLOAD))",
    );
    expect(result.cppCode).toContain(
      "BEGIN(IEC_REFERENCE_TO<ST_EQUIPMENTDATA>(REFMOTOR.target())",
    );
  });
});
