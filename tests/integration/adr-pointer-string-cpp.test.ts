/**
 * ADR into a POINTER TO of any target type, and a REFERENCE TO STRING /
 * WSTRING used as the string it is bound to.
 *
 * ADR, POINTER TO and REFERENCE TO are CODESYS's ("Operator: ADR", "Data
 * Type: POINTER TO", "Data Type: REFERENCE TO"); IEC 61131-3 Ed.3 has REF_TO
 * and REF() (6.4.4.10), a dereferenced reference being "used in the same way
 * as using a variable directly" (6.4.4.10.3), which is how CODESYS uses a
 * REFERENCE TO.
 *
 * `p := ADR(s)` was refused ("Cannot assign __XWORD to STRING") for a
 * POINTER TO STRING(n), STRING, WSTRING, a structure or a block: the checker
 * typed the pointer as its target type, so the address passed only where
 * that was an integer (or an array). A REFERENCE TO STRING / WSTRING did not
 * compile in a comparison, a string function or an assignment to a STRING of
 * another length.
 * Each failed check adds its own power of two; the test wants 0.
 */

import { describe, it, expect } from "vitest";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
TYPE
  S_P : STRUCT a : INT; END_STRUCT;
  S_Hold : STRUCT ps : POINTER TO STRING(4); pw : POINTER TO WSTRING; END_STRUCT;
END_TYPE

FUNCTION_BLOCK FB_X
  VAR_INPUT n : INT; END_VAR
  METHOD PUBLIC M : INT
    VAR_INPUT q : POINTER TO WSTRING(4); END_VAR
    M := LEN(q^);
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION F_Len : INT
  VAR_INPUT p : POINTER TO STRING(4); q : POINTER TO S_P; END_VAR
  F_Len := LEN(p^) + q^.a;
END_FUNCTION

FUNCTION F_Adr : DINT
  VAR
    s4 : STRING(4) := 'ab'; s : STRING := 'cd'; w4 : WSTRING(4) := "ab"; w : WSTRING := "cd";
    st : S_P; ar : ARRAY[1..3] OF INT; fb : FB_X; i : INT;
    p1 : POINTER TO STRING(4);
    p2 : POINTER TO STRING;
    p3 : POINTER TO WSTRING(4);
    p4 : POINTER TO WSTRING;
    p5 : POINTER TO S_P;
    p6 : POINTER TO ARRAY[1..3] OF INT;
    p7 : POINTER TO FB_X;
    p8 : POINTER TO INT;
    h : S_Hold;
    fault : DINT;
  END_VAR
  p1 := ADR(s4);
  p2 := ADR(s);
  p3 := ADR(w4);
  p4 := ADR(w);
  p5 := ADR(st);
  p6 := ADR(ar);
  p7 := ADR(fb);
  p8 := ADR(i);
  IF p1^ <> 'ab' OR p2^ <> 'cd' OR p3^ <> "ab" OR p4^ <> "cd" THEN fault := fault + 1; END_IF;
  p1^ := 'xy';
  p4^ := "zz";
  IF s4 <> 'xy' OR w <> "zz" THEN fault := fault + 2; END_IF;
  p5^.a := 3;
  p6^[2] := 4;
  p7^.n := 5;
  p8^ := 6;
  IF st.a <> 3 OR ar[2] <> 4 OR fb.n <> 5 OR i <> 6 THEN fault := fault + 4; END_IF;
  (* a pointer member, and pointer inputs *)
  h.ps := ADR(s4);
  h.pw := ADR(w);
  IF h.ps^ <> 'xy' OR h.pw^ <> "zz" THEN fault := fault + 8; END_IF;
  IF F_Len(p := ADR(s4), q := ADR(st)) <> 5 OR F_Len(ADR(s4), ADR(st)) <> 5 OR fb.M(q := ADR(w4)) <> 2 THEN fault := fault + 16; END_IF;
  (* a pointer from another *)
  p2 := p1;
  IF p2^ <> 'xy' THEN fault := fault + 32; END_IF;
  F_Adr := fault;
END_FUNCTION

FUNCTION F_Ref : DINT
  VAR
    s4 : STRING(4) := 'ab'; t : STRING(8) := 'b'; w4 : WSTRING(4) := "ab"; tw : WSTRING(8) := "b";
    r1 : REFERENCE TO STRING(4);
    r3 : REFERENCE TO WSTRING(4);
    v : STRING(10); vw : WSTRING(10);
    fault : DINT;
  END_VAR
  r1 REF= s4;
  r3 REF= w4;
  (* every comparison, both ways round *)
  IF NOT (r1 = 'ab') OR r1 <> s4 OR NOT (s4 = r1) OR NOT (r1 < t) OR NOT (r1 <= 'ab') OR NOT ('a' < r1) OR r1 > t OR r1 >= t THEN fault := fault + 1; END_IF;
  IF NOT (r3 = "ab") OR r3 <> w4 OR NOT (w4 = r3) OR NOT (r3 < tw) OR NOT (r3 <= "ab") OR NOT ("a" < r3) OR r3 > tw OR r3 >= tw THEN fault := fault + 2; END_IF;
  (* the string functions *)
  IF NOT EQ(r1, s4) OR LEN(r1) <> 2 OR CONCAT(r1, 'x') <> 'abx' OR MAX(r1, t) <> t OR SEL(TRUE, r1, t) <> t THEN fault := fault + 4; END_IF;
  IF NOT EQ(r3, w4) OR LEN(r3) <> 2 OR CONCAT(r3, "x") <> "abx" OR MAX(r3, tw) <> tw THEN fault := fault + 8; END_IF;
  (* read into a longer string, write through *)
  v := r1;
  vw := r3;
  r1 := 'cd';
  r3 := "cd";
  IF v <> 'ab' OR vw <> "ab" OR s4 <> 'cd' OR w4 <> "cd" THEN fault := fault + 16; END_IF;
  F_Ref := fault;
END_FUNCTION
`;

describeIfGpp("ADR into a POINTER TO, and a REFERENCE TO a string", () => {
  it("assigns an address to any pointer and reads a reference as its string", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'adr into pointers'
  ASSERT_EQ(F_Adr(), 0);
END_TEST

TEST 'reference to string'
  ASSERT_EQ(F_Ref(), 0);
END_TEST
`,
      testFileName: "test_adr_pointer_string.st",
      tempDirPrefix: "strucpp-adrptr-",
    });
    expect(stdout).toContain("[PASS] adr into pointers");
    expect(stdout).toContain("[PASS] reference to string");
    expect(exitCode).toBe(0);
  });
});
