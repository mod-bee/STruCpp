/**
 * A FUNCTION's VAR_OUTPUT is passed by pointer, as a method's is (f295701):
 * NULL when the call omits it, so the function binds a slot of its own and a
 * call site builds no temporary. Omitted, bound, partly bound, named and
 * reordered, positional with trailing outputs left out, inside expressions,
 * a STRING of another length, a VAR_IN_OUT beside them (unchanged), a library
 * function, and an {external} body writing an output by name and by address.
 * Run through the test framework, so the test build's dispatch wrapper
 * forwards outputs too.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
FUNCTION F_Div : DINT
  VAR_INPUT a : DINT; b : DINT; END_VAR
  VAR_OUTPUT nRem : DINT; sText : STRING(16); END_VAR
  nRem := a MOD b;
  sText := 'divided';
  F_Div := a / b;
END_FUNCTION

FUNCTION F_Acc : DINT
  VAR_INPUT n : DINT; END_VAR
  VAR_IN_OUT nTotal : DINT; END_VAR
  VAR_OUTPUT nWas : DINT; END_VAR
  nWas := nTotal;
  nTotal := nTotal + n;
  F_Acc := nTotal;
END_FUNCTION

FUNCTION F_Native : DINT
  VAR_OUTPUT nA : DINT; nB : DINT; END_VAR
  {external
    NA = 41;
    strucpp::IEC_DINT* p = &NB;
    *p = 1;
  }
  F_Native := nA + nB;
END_FUNCTION

FUNCTION F_Run : DINT
  VAR
    r, n1, n2, n3, n4, nA, nB, nT, nW : DINT;
    sShort : STRING(4);
    sLong : STRING(40);
  END_VAR
  r := F_Div(a := 17, b := 5);                               (* omitted: 3 *)
  r := r + F_Div(a := 17, b := 5, nRem => n1);               (* partly: 3, n1 = 2 *)
  r := r + F_Div(nRem => n2, sText => sLong, b := 4, a := 9); (* reordered: 2, n2 = 1 *)
  r := r + F_Div(23, 5);                                     (* positional, trailing omitted: 4 *)
  r := r + F_Div(a := 7, b := 2, sText => sShort) * 10;      (* in an expression: 30 *)
  n3 := F_Div(a := 10, b := 3, nRem => n4) + F_Div(a := 1, b := 1);
  nT := 5;
  r := r + F_Acc(n := 2, nTotal := nT);                      (* in-out unchanged: 7 *)
  r := r + F_Acc(n := 1, nTotal := nT, nWas => nW);          (* 8, nW = 7 *)
  r := r + F_Native(nA => nA);                               (* 42 *)
  r := r + F_Native(nA => nA, nB => nB);                     (* 42 *)
  IF n1 <> 2 OR n2 <> 1 OR n3 <> 4 OR n4 <> 1 OR nW <> 7 OR nT <> 8 OR nA <> 41 OR nB <> 1 THEN
    r := -1;
  END_IF;
  IF sShort <> 'divi' OR sLong <> 'divided' THEN
    r := -2;
  END_IF;
  F_Run := r;
END_FUNCTION
`;

describeIfGpp("a function's outputs by pointer", () => {
  it("omits an output with NULL: no temporary at the call site", () => {
    const result = compile(SOURCE);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).not.toContain("__output_tmp_");
    expect(result.cppCode).toContain("F_DIV(17, 5, nullptr, nullptr)");
    expect(result.headerCode).toMatch(
      /F_DIV\(DINT_t A__in, DINT_t B__in, IEC_DINT\* NREM__out, IECStringVar<16>\* STEXT__out\)/,
    );
  });

  it("writes bound outputs and drops omitted ones, in every kind of call", () => {
    // 3 + 3 + 2 + 4 + 30 + 7 + 8 + 42 + 42 = 141
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'function outputs by pointer'
  ASSERT_EQ(F_Run(), 141);
END_TEST
`,
      testFileName: "test_fn_outputs.st",
      tempDirPrefix: "strucpp-fn-outputs-",
    });
    expect(stdout).toContain("[PASS] function outputs by pointer");
    expect(exitCode).toBe(0);
  });

  it("calls a library function the same way", () => {
    const built = compileStlib(
      [
        {
          fileName: "lib.st",
          source: `
FUNCTION F_LibSplit : DINT
  VAR_INPUT n : DINT; END_VAR
  VAR_OUTPUT nHigh : DINT; nLow : DINT; END_VAR
  nHigh := n / 100;
  nLow := n MOD 100;
  F_LibSplit := nHigh + nLow;
END_FUNCTION
`,
        },
      ],
      { name: "split-lib", version: "1.0.0", namespace: "splitlib" },
    );
    expect(built.errors).toEqual([]);
    const archive = JSON.parse(JSON.stringify(built.archive)) as StlibArchive;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `
FUNCTION F_UseLib : DINT
  VAR h, l : DINT; END_VAR
  F_UseLib := F_LibSplit(n := 1234);
  F_UseLib := F_UseLib + F_LibSplit(n := 567, nLow => l) + F_LibSplit(n := 890, nHigh => h);
  F_UseLib := F_UseLib * 1000 + h * 100 + l;
END_FUNCTION
`,
      testST: `
TEST 'library function outputs'
  ASSERT_EQ(F_UseLib(), 216867);
END_TEST
`,
      testFileName: "test_lib_fn_outputs.st",
      tempDirPrefix: "strucpp-lib-fn-outputs-",
      compileOptions: { libraries: [archive] },
    });
    expect(stdout).toContain("[PASS] library function outputs");
    expect(exitCode).toBe(0);
  });
});
