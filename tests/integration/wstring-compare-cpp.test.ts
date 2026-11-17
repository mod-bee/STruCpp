/**
 * WSTRING compares as STRING does (IEC 61131-3 Ed.3 Table 33, comparison
 * functions, which 6.6.2.5.11 makes "applicable to character strings":
 * "the shorter string shall be considered to be extended on the right to the
 * length of the longer string by characters with the value zero. Comparison
 * shall proceed from left to right, based on the numeric value of the
 * character codes in the character set.").
 *
 * Every comparison operator (=, <>, <, >, <=, >=) and every comparison
 * function (EQ, NE, GT, GE, LT, LE, extensible ones with three inputs), and
 * the selection functions built on them (SEL, MUX, MAX, MIN, LIMIT), on a
 * WSTRING variable of any length against a literal, another WSTRING
 * variable, a structure member, an array element, a function result, a
 * reference and a global. And what a WSTRING of one length needs to reach
 * another: a function, block or method input of another length, and a
 * number to WSTRING (DINT_TO_WSTRING and TO_WSTRING, as for STRING;
 * Table 22).
 * F_Str runs the same checks on STRING, which already passed, so both
 * types are held to one rule.
 *
 * None of it compiled for WSTRING: the runtime had no = / <> for a WSTRING
 * variable against a literal or another variable, no SEL / MUX on WSTRINGs
 * of different lengths, no WSTRING(n) built from another length, no
 * number to WSTRING, and TO_WSTRING was an unknown function.
 * Each failed check adds its own power of two; the test wants 0.
 */

import { describe, it, expect } from "vitest";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

/** The checks, for STRING (quote ') or WSTRING (quote "). */
const checks = (fn: string, ty: string, q: string): string => {
  const l = (s: string) => `${q}${s}${q}`;
  return `
TYPE S_${ty}Box : STRUCT txt : ${ty}(6) := ${l("wz")}; END_STRUCT; END_TYPE

FUNCTION F_${ty}Lit : ${ty}(8)
  VAR_INPUT s : ${ty}(8); END_VAR
  F_${ty}Lit := s;
END_FUNCTION

FUNCTION F_${ty}Any : BOOL
  VAR_INPUT s : ${ty}; END_VAR
  F_${ty}Any := s = ${l("wz")};
END_FUNCTION

FUNCTION_BLOCK FB_${ty}
  VAR_INPUT i : ${ty}(6); END_VAR
  VAR_OUTPUT o : ${ty}(6); END_VAR
  METHOD PUBLIC M : BOOL
    VAR_INPUT x : ${ty}(3); END_VAR
    M := x = i;
  END_METHOD
  o := i;
END_FUNCTION_BLOCK

VAR_GLOBAL g_${ty} : ${ty}(4) := ${l("wz")}; END_VAR

FUNCTION ${fn}2 : DINT
  VAR_EXTERNAL g_${ty} : ${ty}(4); END_VAR
  VAR
    w : ${ty}(2) := ${l("wz")};
    wa : ${ty}(8) := ${l("wza")};
    fb : FB_${ty};
    rw : REF_TO ${ty}(2);
    k : DINT := -42;
    v : ${ty}(8);
    fault : DINT;
  END_VAR
  (* a ${ty}(2) into a plain ${ty} input, a ${ty}(6) one and a ${ty}(3) one *)
  IF NOT F_${ty}Any(w) OR F_${ty}Any(s := wa) THEN fault := fault + 1; END_IF;
  fb(i := w);
  IF fb.o <> w OR NOT fb.M(x := w) OR fb.M(x := wa) THEN fault := fault + 2; END_IF;
  (* through a reference, and a global *)
  rw := REF(w);
  IF rw^ <> ${l("wz")} OR NOT (rw^ = w) OR NOT (rw^ < wa) THEN fault := fault + 4; END_IF;
  IF g_${ty} <> w OR NOT (g_${ty} = ${l("wz")}) OR NOT (g_${ty} < wa) OR NOT EQ(g_${ty}, w) THEN fault := fault + 8; END_IF;
  (* to and from a number *)
  v := DINT_TO_${ty}(k);
  IF v <> ${l("-42")} OR ${ty}_TO_DINT(v) <> -42 THEN fault := fault + 16; END_IF;
  (* the overloaded TO_${ty} (Table 22 1b), of a number and of its own type *)
  v := TO_${ty}(k);
  IF v <> ${l("-42")} OR TO_${ty}(w) <> w OR TO_DINT(v) <> -42 THEN fault := fault + 32; END_IF;
  ${fn}2 := fault;
END_FUNCTION

FUNCTION ${fn} : DINT
  VAR
    w : ${ty}(2) := ${l("wz")};
    wz : ${ty}(8) := ${l("wz")};
    wa : ${ty}(8) := ${l("wza")};
    wb : ${ty} := ${l("x")};
    box : S_${ty}Box;
    arr : ARRAY[1..2] OF ${ty}(4) := [${l("wz")}, ${l("a")}];
    r : ${ty}(8);
    fault : DINT;
  END_VAR
  (* a variable against a literal, both ways round *)
  IF NOT (w = ${l("wz")}) OR w <> ${l("wz")} OR NOT (${l("wz")} = w) OR ${l("wz")} <> w THEN fault := fault + 1; END_IF;
  IF w = ${l("wza")} OR NOT (w <> ${l("w")}) OR NOT (w < ${l("x")}) OR NOT (w > ${l("w")}) THEN fault := fault + 2; END_IF;
  IF NOT (w <= ${l("wz")}) OR NOT (w >= ${l("wz")}) OR w <= ${l("w")} OR w >= ${l("wza")} THEN fault := fault + 4; END_IF;
  (* against another variable, of different lengths: the shorter sorts first *)
  IF NOT (w = wz) OR w <> wz OR w = wa OR NOT (w <> wa) THEN fault := fault + 8; END_IF;
  IF NOT (w < wa) OR w > wa OR NOT (wa > w) OR NOT (w <= wa) OR w >= wa OR NOT (wb >= wa) THEN fault := fault + 16; END_IF;
  (* a structure member, an array element, a function result *)
  IF box.txt <> w OR NOT (box.txt = ${l("wz")}) OR arr[1] <> wz OR NOT (arr[2] < arr[1]) THEN fault := fault + 32; END_IF;
  IF F_${ty}Lit(${l("wz")}) <> w OR NOT (F_${ty}Lit(s := wa) > w) OR F_${ty}Lit(${l("a")}) >= arr[1] THEN fault := fault + 64; END_IF;
  (* two literals *)
  IF NOT (${l("ab")} = ${l("ab")}) OR ${l("ab")} <> ${l("ab")} OR NOT (${l("ab")} < ${l("b")}) THEN fault := fault + 128; END_IF;
  (* the comparison functions, extensible ones with three inputs *)
  IF NOT EQ(w, ${l("wz")}) OR NOT EQ(w, wz, box.txt) OR EQ(w, wa) OR NOT NE(w, wa) OR NE(w, wz) THEN fault := fault + 256; END_IF;
  IF NOT GT(wb, wa, w) OR GT(w, wa) OR NOT GE(wb, wz, w) OR NOT LT(w, wa, wb) OR NOT LE(w, wz, wa) OR LE(wa, w) THEN fault := fault + 512; END_IF;
  (* selection *)
  r := SEL(TRUE, w, wa);
  IF r <> wa THEN fault := fault + 1024; END_IF;
  r := MUX(1, w, wa, wb);
  IF r <> ${l("wza")} THEN fault := fault + 2048; END_IF;
  r := MAX(w, wa, wb);
  IF r <> wb THEN fault := fault + 4096; END_IF;
  r := MIN(wa, w, wb);
  IF r <> w THEN fault := fault + 8192; END_IF;
  r := LIMIT(w, ${l("a")}, wa);
  IF r <> w THEN fault := fault + 16384; END_IF;
  r := LIMIT(w, ${l("zz")}, wa);
  IF r <> wa THEN fault := fault + 32768; END_IF;
  ${fn} := fault;
END_FUNCTION
`;
};

describeIfGpp("WSTRING compares as STRING does", () => {
  it("in every operator and comparison or selection function", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST:
        checks("F_Str", "STRING", "'") + checks("F_WStr", "WSTRING", '"'),
      testST: `
TEST 'string compare'
  ASSERT_EQ(F_Str(), 0);
  ASSERT_EQ(F_Str2(), 0);
END_TEST

TEST 'wstring compare'
  ASSERT_EQ(F_WStr(), 0);
  ASSERT_EQ(F_WStr2(), 0);
END_TEST
`,
      testFileName: "test_wstring_compare.st",
      tempDirPrefix: "strucpp-wstrcmp-",
    });
    expect(stdout).toContain("[PASS] string compare");
    expect(stdout).toContain("[PASS] wstring compare");
    expect(exitCode).toBe(0);
  });
});
