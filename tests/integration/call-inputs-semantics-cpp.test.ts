/**
 * How a call passes its inputs, pinned before the call-site size work and
 * kept after it (behaviour identical):
 * - a METHOD or FUNCTION input the call omits takes its declared initial
 *   value at every call (IEC 61131-3 Ed.3 6.6.1.4.2, "Function... the values
 *   of the input variables ... shall be assigned their initial values" when
 *   not given; a method is called as a function is, 6.6.5.4), even after an
 *   earlier call gave it a value;
 * - an FB instance call that omits an input keeps its last value (6.6.3.4);
 * - an input is the callee's own copy: writing it there changes nothing for
 *   the caller; a STRING input holds at most its declared length;
 * - an ANY input describes the caller's variable; enumeration, structure and
 *   REAL inputs (an INT widened to one) arrive as given;
 * - interfaces and overrides pass inputs alike; a C++ ({external}) body
 *   reads an input by name and by address.
 * Each failed check adds its own power of two; the test wants 0.
 */

import { describe, it, expect } from "vitest";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
TYPE
  E_Mode : (Idle, Run, Stop) := Idle;
  S_Pair : STRUCT a : INT; b : INT; END_STRUCT;
END_TYPE

INTERFACE I_Calc
  METHOD Calc : DINT
    VAR_INPUT n : INT := 5; END_VAR
  END_METHOD
END_INTERFACE

FUNCTION_BLOCK FB_Calc IMPLEMENTS I_Calc
  VAR_INPUT nPin : INT := 3; END_VAR
  VAR_OUTPUT nSeen : INT; END_VAR
  METHOD PUBLIC Calc : DINT
    VAR_INPUT n : INT := 5; END_VAR
    Calc := n;
  END_METHOD
  METHOD PUBLIC Mix : DINT
    VAR_INPUT
      n : INT := 5;
      s : STRING(4) := 'ab';
      b : BOOL := TRUE;
      t : TIME := T#2s;
      f : REAL := 1.5;
      e : E_Mode := E_Mode.Run;
      p : S_Pair;
    END_VAR
    VAR_OUTPUT sOut : STRING(4); nLen : INT; END_VAR
    sOut := s;
    nLen := LEN(s);
    Mix := n;
    IF b THEN Mix := Mix + 100; END_IF;
    IF t = T#2s THEN Mix := Mix + 1000; END_IF;
    IF f > 1.4 AND f < 1.6 THEN Mix := Mix + 10000; END_IF;
    IF e = E_Mode.Run THEN Mix := Mix + 100000; END_IF;
    Mix := Mix + p.a * 1000000 + p.b * 10000000;
    n := 99;
    s := 'zzzz';
    p.a := 7;
  END_METHOD
  METHOD PUBLIC Real2 : REAL
    VAR_INPUT f : REAL; END_VAR
    Real2 := f * 2.0;
  END_METHOD
  METHOD PUBLIC AnySize : DINT
    VAR_INPUT x : ANY; END_VAR
    {external
      ANYSIZE_result = X.DISIZE;
    }
  END_METHOD
  METHOD PUBLIC Native : DINT
    VAR_INPUT n : INT := 4; m : DINT; END_VAR
    {external
      const strucpp::IEC_DINT* pm = &M;
      NATIVE_result = N + *pm;
      N = 77;
    }
  END_METHOD
  nSeen := nPin;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Calc2 EXTENDS FB_Calc
  METHOD PUBLIC OVERRIDE Calc : DINT
    VAR_INPUT n : INT := 5; END_VAR
    Calc := SUPER^.Calc(n := n) + 1000;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION F_Mix : DINT
  VAR_INPUT n : INT := 5; s : STRING(4) := 'ab'; END_VAR
  F_Mix := n + LEN(s) * 100;
  n := 99;
END_FUNCTION

FUNCTION F_Check : DINT
  VAR
    c : FB_Calc;
    c2 : FB_Calc2;
    ip : I_Calc;
    k : INT := 3;
    r : DINT;
    so : STRING(4);
    sl : STRING(10) := 'longer';
    nl : INT;
    i : INT := 4;
    pair : S_Pair := (a := 1, b := 2);
    big : ARRAY[1..5] OF DINT;
    fault : DINT;
  END_VAR
  (* omitted inputs: the declared initial values *)
  r := c.Mix();
  IF r <> 111105 THEN fault := fault + 1; END_IF;
  (* given ones, then omitted again: the defaults come back *)
  r := c.Mix(n := k, s := 'x', b := FALSE, t := T#1s, f := 2.5, e := E_Mode.Stop, p := pair, sOut => so);
  IF r <> 21000003 OR so <> 'x' THEN fault := fault + 2; END_IF;
  r := c.Mix(sOut => so, nLen => nl);
  IF r <> 111105 OR so <> 'ab' OR nl <> 2 THEN fault := fault + 4; END_IF;
  (* the callee's copy: the caller's variables are untouched *)
  IF k <> 3 OR pair.a <> 1 THEN fault := fault + 8; END_IF;
  (* a STRING input holds its declared length *)
  r := c.Mix(s := 'abcdefgh', sOut => so, nLen => nl);
  IF so <> 'abcd' OR nl <> 4 THEN fault := fault + 16; END_IF;
  r := c.Mix(s := sl, nLen => nl);
  IF nl <> 4 THEN fault := fault + 32; END_IF;
  r := c.Mix(s := CONCAT('a', 'b'), nLen => nl);
  IF nl <> 2 THEN fault := fault + 64; END_IF;
  (* an INT widened to a REAL input *)
  IF c.Real2(f := i) <> 8.0 THEN fault := fault + 128; END_IF;
  (* ANY: the caller's variable *)
  IF c.AnySize(x := big) <> 20 THEN fault := fault + 256; END_IF;
  (* interface and override *)
  ip := c;
  IF ip.Calc() <> 5 OR ip.Calc(n := 8) <> 8 THEN fault := fault + 512; END_IF;
  ip := c2;
  IF ip.Calc() <> 1005 OR ip.Calc(n := 2) <> 1002 THEN fault := fault + 1024; END_IF;
  (* a C++ body: by name and by address; writing its copy changes nothing *)
  IF c.Native(m := 10) <> 14 OR c.Native(n := k, m := 1) <> 4 OR k <> 3 THEN fault := fault + 2048; END_IF;
  (* a function: the same *)
  IF F_Mix() <> 205 OR F_Mix(n := k, s := 'abcdef') <> 403 OR F_Mix() <> 205 OR k <> 3 THEN fault := fault + 4096; END_IF;
  (* an FB instance call keeps an omitted input's last value *)
  c(nPin := 9);
  c();
  IF c.nSeen <> 9 THEN fault := fault + 8192; END_IF;
  F_Check := fault;
END_FUNCTION
`;

describeIfGpp("how a call passes its inputs", () => {
  it("keeps IEC semantics for omitted, given and copied inputs", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'call inputs'
  ASSERT_EQ(F_Check(), 0);
END_TEST
`,
      testFileName: "test_call_inputs.st",
      tempDirPrefix: "strucpp-call-inputs-",
    });
    expect(stdout).toContain("[PASS] call inputs");
    expect(exitCode).toBe(0);
  });
});
