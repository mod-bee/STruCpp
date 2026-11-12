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

// IEC 61131-3 6.4.4.10.3: "A dereferenced reference can be used in the same
// way as using a variable directly" - a REF_TO a block is called with `r^()`.
describeIfGpp("a block called through a dereferenced reference", () => {
  it("runs rf^(), rf^(in := v), s.r^() and arr[i]^()", () => {
    const { stdout, exitCode } = run(
      `
FUNCTION_BLOCK FB_T
  VAR_INPUT inc : INT := 1; END_VAR
  VAR_OUTPUT q : INT; END_VAR
  q := q + inc;
END_FUNCTION_BLOCK
TYPE ST : STRUCT r : REF_TO FB_T; END_STRUCT END_TYPE
FUNCTION F_Calls : INT
  VAR f : FB_T; rf : REF_TO FB_T; s : ST; arr : ARRAY[1..2] OF REF_TO FB_T; END_VAR
  rf := REF(f);
  rf^();
  rf^(inc := 5);
  s.r := REF(f);
  s.r^(inc := 10);
  arr[2] := REF(f);
  arr[2]^();
  F_Calls := rf^.q;
END_FUNCTION
`,
      `
TEST 'calls through REF_TO'
  ASSERT_EQ(F_Calls(), 26);  (* 1 + 5 + 10 + 10: an input keeps its last value *)
END_TEST
`,
      "ref_call",
    );
    expect(stdout).toContain("[PASS] calls through REF_TO");
    expect(exitCode).toBe(0);
  });
});

// IEC 61131-3 6.5.2.2 (VAR_GLOBAL): a global may be of any type, a function
// block included. The C++ variable needs its class complete first.
describeIfGpp("a top-level VAR_GLOBAL of a block type", () => {
  it("is emitted after its class and runs", () => {
    const { stdout, exitCode } = run(
      `
FUNCTION_BLOCK FB_X
  VAR_INPUT x : INT := 3; END_VAR
  VAR_OUTPUT q : INT; END_VAR
  q := q + x;
END_FUNCTION_BLOCK
VAR_GLOBAL
  gx : FB_X := (x := 9);
  ga : ARRAY[1..2] OF FB_X;
  gn : INT := 4;
END_VAR
FUNCTION F_Global : INT
  gx();
  ga[2](x := gn);
  F_Global := gx.q + ga[2].q;
END_FUNCTION
`,
      `
TEST 'block-typed globals'
  ASSERT_EQ(F_Global(), 13);
END_TEST
`,
      "fb_global",
    );
    expect(stdout).toContain("[PASS] block-typed globals");
    expect(exitCode).toBe(0);
  });
});

// A TEST variable is declared like any variable (IEC 61131-3 6.5.1): a
// POINTER TO / REF_TO a block is a pointer, not an instance.
describeIfGpp("pointers and references in TEST variables", () => {
  it("declares POINTER TO and REF_TO a block as pointers", () => {
    const { stdout, exitCode } = run(
      `
FUNCTION_BLOCK FB_C
  VAR_OUTPUT n : INT; END_VAR
  METHOD PUBLIC Bump : INT n := n + 1; Bump := n; END_METHOD
END_FUNCTION_BLOCK
`,
      `
TEST 'pointer test variables'
  VAR p : POINTER TO FB_C; r : REF_TO FB_C; f : FB_C; k : INT; END_VAR
  p := __NEW(FB_C);
  k := p^.Bump();
  k := p^.Bump();
  ASSERT_EQ(k, 2);
  __DELETE(p);
  r := REF(f);
  r^.Bump();
  ASSERT_EQ(f.n, 1);
END_TEST
`,
      "test_ptr",
    );
    expect(stdout).toContain("[PASS] pointer test variables");
    expect(exitCode).toBe(0);
  });
});
