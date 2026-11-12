// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A library enumeration's attribute pragmas reach its consumers (CODESYS
 * "Attribute: qualified_only", "Enumeration" strict programming rules): the
 * manifest carries them, and a project using the library enforces them as
 * the library's own code is checked.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

/** Built from a datatype file as a library project holds it (`.dt`). */
const library = (): StlibArchive => {
  const lib = compileStlib(
    [
      {
        fileName: "E_OtaState.dt",
        source: `{attribute 'qualified_only'}
{attribute 'strict'}
TYPE
  E_OtaState : USINT (Idle := 0, Ready := 1, Busy := 2) := Idle;
END_TYPE
`,
      },
      {
        fileName: "F_Ota.st",
        source: `
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

const errorsOf = (src: string): string[] =>
  compile(src, { libraries: [library()] }).errors.map((e) => e.message);

describe("library enumeration attributes", () => {
  it("are carried in the manifest", () => {
    const entry = library().manifest.types.find((t) => t.name === "E_OTASTATE");
    expect(entry?.attributes).toEqual([
      { name: "qualified_only" },
      { name: "strict" },
    ]);
  });

  it("qualified_only: a consumer's bare value is refused", () => {
    expect(
      errorsOf(`
PROGRAM P
  VAR s : E_OtaState; END_VAR
  s := Ready;
END_PROGRAM
`),
    ).toEqual([
      "'READY' is a value of 'E_OTASTATE', declared {attribute 'qualified_only'}: write 'E_OTASTATE.READY'",
    ]);
  });

  it("strict: a consumer may not assign a number or compute with it", () => {
    expect(
      errorsOf(`
PROGRAM P
  VAR s : E_OtaState; n : USINT; END_VAR
  s := 1;
  s := s + 1;
  n := s;
END_PROGRAM
`),
    ).toEqual([
      "Cannot assign INT to E_OTASTATE",
      "Operator '+' is not defined for the enumeration E_OTASTATE: IEC 61131-3 Table 38 admits only SEL, MUX, EQ and NE",
    ]);
  });
});

describeIfGpp("library enumeration attributes at run time", () => {
  it("runs the qualified values, and a same-named variable stays a variable", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `
FUNCTION F_Check : INT
  VAR s : E_OtaState := E_OtaState.Busy; Ready : INT := 5; END_VAR
  IF F_Ota() = E_OtaState.Ready THEN F_Check := 1; END_IF
  IF s = E_OtaState.Busy THEN F_Check := F_Check + 10; END_IF
  F_Check := F_Check + Ready * 100;
END_FUNCTION
`,
      testST: `
TEST 'qualified library values'
  ASSERT_EQ(F_Check(), 511);
END_TEST
`,
      testFileName: "test_lib_enum_attrs.st",
      tempDirPrefix: "strucpp-lib-enum-attrs-",
      compileOptions: { libraries: [library()] },
    });
    expect(stdout).toContain("[PASS] qualified library values");
    expect(exitCode).toBe(0);
  });
});
