// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Fixes of gaps found while proving the OOP features end to end. Each case
 * names the clause of IEC 61131-3 Ed.3 or the CODESYS online help page that
 * defines the behaviour.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const errorsOf = (src: string): string[] =>
  compile(src).errors.map((e) => e.message);

const run = (sourceST: string, testST: string, name: string) =>
  runE2ETestPipeline({
    sourceST,
    testST,
    testFileName: `test_${name}.st`,
    tempDirPrefix: `strucpp-bugfix-${name}-`,
  });

// IEC 61131-3 6.6.5.7.2: THIS is the own instance; a member path follows it.
// CODESYS writes it THIS^.
describeIfGpp("a path from THIS", () => {
  it("reads and writes members, elements and nested instances", () => {
    const { stdout, exitCode } = run(
      `
TYPE ST : STRUCT n : INT; arr : ARRAY[1..3] OF INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_In
  VAR_OUTPUT q : INT; END_VAR
  METHOD PUBLIC Twice : INT Twice := q * 2; END_METHOD
  q := q + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB
  VAR_OUTPUT k : INT; END_VAR
  VAR s : ST; a : ARRAY[1..3] OF INT; inner : FB_In; END_VAR
  THIS.s.n := 5;
  THIS^.s.arr[2] := 6;
  THIS.a[1] := 7;
  THIS^.inner();
  k := THIS.s.n + THIS^.a[1] + THIS.s.arr[2] + THIS.inner.q + THIS^.inner.Twice();
END_FUNCTION_BLOCK
`,
      `
TEST 'THIS paths'
  VAR f : FB; END_VAR
  f();
  ASSERT_EQ(f.k, 21);
END_TEST
`,
      "this_path",
    );
    expect(stdout).toContain("[PASS] THIS paths");
    expect(exitCode).toBe(0);
  });
});
