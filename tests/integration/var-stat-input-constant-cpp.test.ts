// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * VAR_STAT and VAR_INPUT CONSTANT (CODESYS online help, "Variable: VAR_STAT",
 * "Variable: CONSTANT"; extensions of IEC 61131-3, whose Input_Decls take no
 * CONSTANT, Annex A):
 *
 * - VAR_STAT: static variables, initialized once and kept between calls, one
 *   storage for the POU ("like static variables in C"): shared by every
 *   instance of a block, and of a method's block.
 * - VAR_INPUT CONSTANT: a constant variable, read-only in the implementation
 *   and "via the instance path"; its value comes from its declaration or the
 *   instance's initial assignment.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import {
  compileWithGpp,
  createPCH,
  hasGpp,
  runE2ETestPipeline,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const errorsOf = (src: string): string[] =>
  compile(src).errors.map((e) => e.message);

const SOURCE = `
FUNCTION F_Count : INT
  VAR_STAT n : INT := 10; END_VAR
  n := n + 1;
  F_Count := n;
END_FUNCTION

FUNCTION_BLOCK FB_S
  VAR_INPUT CONSTANT nLimit : INT := 3; END_VAR
  VAR_OUTPUT nSeen : INT; END_VAR
  VAR_STAT nCalls : INT; END_VAR
  VAR_STAT CONSTANT nStep : INT := 2; END_VAR
  METHOD PUBLIC Shared : INT
    VAR_STAT nMethodCalls : INT; END_VAR
    nMethodCalls := nMethodCalls + 1;
    Shared := nMethodCalls;
  END_METHOD
  METHOD PUBLIC Limit : INT
    Limit := nLimit;
  END_METHOD
  nCalls := nCalls + nStep;
  nSeen := nCalls;
END_FUNCTION_BLOCK
`;

describeIfGpp("VAR_STAT and VAR_INPUT CONSTANT at run time", () => {
  it("keeps static values between calls and shares them between instances", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'VAR_STAT'
  VAR a : FB_S; b : FB_S; END_VAR
  ASSERT_EQ(F_Count(), 11);
  ASSERT_EQ(F_Count(), 12);
  a(); b(); a();
  ASSERT_EQ(a.nSeen, 6);
  ASSERT_EQ(b.nSeen, 4);
  ASSERT_EQ(a.Shared(), 1);
  ASSERT_EQ(b.Shared(), 2);
END_TEST

TEST 'VAR_INPUT CONSTANT'
  VAR a : FB_S; c : FB_S := (nLimit := 9); END_VAR
  ASSERT_EQ(a.Limit(), 3);
  ASSERT_EQ(c.Limit(), 9);
END_TEST
`,
      testFileName: "test_var_stat.st",
      tempDirPrefix: "strucpp-var-stat-",
    });
    expect(stdout).toContain("[PASS] VAR_STAT");
    expect(stdout).toContain("[PASS] VAR_INPUT CONSTANT");
    expect(exitCode).toBe(0);
  });

  it("builds a program's VAR_STAT as one storage for the program type", () => {
    const result = compile(
      `
PROGRAM P
  VAR_STAT nRuns : INT := 100; END_VAR
  VAR k : INT; END_VAR
  nRuns := nRuns + 1;
  k := nRuns;
END_PROGRAM
CONFIGURATION C
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM i WITH t : P;
    PROGRAM j WITH t : P;
  END_RESOURCE
END_CONFIGURATION
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.headerCode).toContain("    static IEC_INT NRUNS;");
    expect(result.cppCode).toContain("IEC_INT Program_P::NRUNS = 100;");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-var-stat-p-"));
    try {
      const built = compileWithGpp({
        tempDir,
        pchPath: createPCH(tempDir),
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "var_stat_prog",
      });
      expect(built.error ?? "").toBe("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("VAR_STAT and VAR_INPUT CONSTANT rules", () => {
  it("accepts the source", () => {
    expect(errorsOf(SOURCE)).toEqual([]);
  });

  it("refuses VAR_STAT RETAIN and VAR_STAT outside a POU", () => {
    expect(
      errorsOf(`
FUNCTION_BLOCK FB_R
  VAR_STAT RETAIN n : INT; END_VAR
END_FUNCTION_BLOCK
`),
    ).toEqual([
      "VAR_STAT RETAIN / PERSISTENT is not supported: a static variable is not retained",
    ]);
    expect(
      errorsOf(`
CONFIGURATION C
  VAR_STAT g : INT; END_VAR
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
  END_RESOURCE
END_CONFIGURATION
`),
    ).toEqual([
      "VAR_STAT is declared in a program, function, function block or method",
    ]);
  });

  it("refuses writing a CONSTANT input in the body, a method and through the instance", () => {
    expect(
      errorsOf(`
FUNCTION_BLOCK FB_K
  VAR_INPUT CONSTANT k : INT := 3; END_VAR
  METHOD PUBLIC M
    k := 4;
  END_METHOD
  k := 5;
END_FUNCTION_BLOCK
PROGRAM P
  VAR f : FB_K; END_VAR
  f.k := 6;
END_PROGRAM
`),
    ).toEqual([
      "Cannot assign to 'F.K': it is declared VAR_INPUT CONSTANT, read-only through the instance too",
      "Cannot assign to CONSTANT variable 'K'",
      "Cannot assign to CONSTANT variable 'K'",
    ]);
  });
});
