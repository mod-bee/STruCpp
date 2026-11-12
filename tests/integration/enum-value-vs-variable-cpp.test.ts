// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A variable in scope wins over an unqualified enumeration value of the same
 * name. IEC 61131-3 6.4.4.2: "To enable unique identification when used in a
 * particular context, enumerated literals may be qualified" (`E#v`); 6.5.2.2:
 * a POU's declarations are in its scope; 6.6.5.5.2 rule 2: a derived block
 * uses its base's variables as its own. CODESYS "Attribute: qualified_only":
 * qualifying avoids an enumeration value "being mistaken for local
 * variables".
 *
 * Seen as `Ready := Ready AND DriveReady;` in a block that EXTENDS one with
 * a VAR_OUTPUT `Ready`, beside a library enumeration with a value `Ready`.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const library = (): StlibArchive => {
  const lib = compileStlib(
    [
      {
        fileName: "ota.st",
        source: `
TYPE E_OtaState : (Idle, Ready, Busy) := Idle; END_TYPE
TYPE E_Code : USINT (Count := 7, Other := 9) := Count; END_TYPE
FUNCTION F_Ota : E_OtaState
  F_Ota := E_OtaState.Ready;
END_FUNCTION
`,
      },
    ],
    { name: "ota-lib", version: "1.0.0", namespace: "otalib" },
  );
  expect(lib.errors).toEqual([]);
  return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
};

const SOURCE = `
VAR_GLOBAL Busy : BOOL := TRUE; END_VAR

FUNCTION_BLOCK FB_Motor
  VAR_OUTPUT Ready : BOOL := TRUE; Count : USINT := 1; END_VAR
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Vsd EXTENDS FB_Motor
  VAR_INPUT DriveReady : BOOL; END_VAR
  METHOD PUBLIC M : BOOL
    VAR_INPUT Idle : BOOL; END_VAR
    M := Idle AND Ready;
  END_METHOD
  Ready := Ready AND DriveReady;
  Count := Count + 1;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Own
  VAR_OUTPUT Ready : BOOL := TRUE; END_VAR
  VAR Idle : INT := 5; END_VAR
  Ready := Ready AND (Idle = 5);
END_FUNCTION_BLOCK

FUNCTION F_Local : INT
  VAR Ready : INT := 40; END_VAR
  Ready := Ready + 2;
  F_Local := Ready;
END_FUNCTION

FUNCTION F_Global : BOOL
  F_Global := Busy AND TRUE;
END_FUNCTION

PROGRAM P_Ext
  VAR_EXTERNAL Busy : BOOL; END_VAR
  VAR b : BOOL; END_VAR
  b := Busy AND TRUE;
END_PROGRAM

FUNCTION F_Qualified : BOOL
  F_Qualified := F_Ota() = E_OtaState.Ready;
END_FUNCTION
`;

describe("a variable wins over an enumeration value of its name", () => {
  it("compiles the variables as variables", () => {
    const result = compile(SOURCE, { libraries: [library()] });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    // Only the qualified value and the library's own function name it.
    const enumUses = result.cppCode
      .split("\n")
      .filter((l) => /E_OTASTATE::(READY|IDLE|BUSY)\b/.test(l))
      .map((l) => l.trim());
    expect(enumUses).toEqual([
      "F_OTA_result = E_OTASTATE::READY;",
      "F_QUALIFIED_result = F_OTA() == E_OTASTATE::READY;",
    ]);
  });
});

describeIfGpp("a variable wins over an enumeration value at run time", () => {
  it("reads and writes the variables", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'variables, not enumeration values'
  VAR v : FB_Vsd; o : FB_Own; END_VAR
  v(DriveReady := TRUE);
  ASSERT_TRUE(v.Ready);
  ASSERT_EQ(v.Count, 2);
  ASSERT_TRUE(v.M(Idle := TRUE));
  ASSERT_FALSE(v.M(Idle := FALSE));
  v(DriveReady := FALSE);
  ASSERT_FALSE(v.Ready);
  o();
  ASSERT_TRUE(o.Ready);
  ASSERT_EQ(F_Local(), 42);
  ASSERT_TRUE(F_Global());
  ASSERT_TRUE(F_Qualified());
END_TEST
`,
      testFileName: "test_enum_vs_var.st",
      tempDirPrefix: "strucpp-enum-vs-var-",
      compileOptions: { libraries: [library()] },
    });
    expect(stdout).toContain("[PASS] variables, not enumeration values");
    expect(exitCode).toBe(0);
  });
});
