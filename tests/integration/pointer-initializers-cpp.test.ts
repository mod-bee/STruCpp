/**
 * A POINTER TO or REF_TO variable initialised in its declaration with the
 * address of a variable: `p : POINTER TO INT := ADR(x)` (CODESYS "Operator:
 * ADR", "Data Type: POINTER TO") and `r : REF_TO INT := REF(x)` (IEC 61131-3
 * Ed.3 6.4.4.10.2: "References can be initialized using the value NULL
 * (default) or the address of an already declared variable").
 *
 * The variable must live as long as the pointer: a global, or a variable of
 * the same program or block. Refused: an in-out (bound anew at every call),
 * a VAR_TEMP for a pointer that is not one, and REF() of a function's or
 * method's variable (6.4.4.10.3). Both were refused outright before
 * ("POINTER TO initializers are not supported").
 * Each failed check adds its own power of two; the test wants 0.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
TYPE S_P : STRUCT a : INT; END_STRUCT; END_TYPE

VAR_GLOBAL
  g : INT := 5;
  gs : STRING(8) := 'gg';
  pgl : POINTER TO INT := ADR(g);
END_VAR

FUNCTION_BLOCK FB_A
  VAR_EXTERNAL g : INT; END_VAR
  VAR_INPUT bump : BOOL; END_VAR
  VAR
    x : INT := 3;
    st : S_P := (a := 4);
    arr : ARRAY[1..3] OF INT := [10, 20, 30];
    px : POINTER TO INT := ADR(x);
    pg : POINTER TO INT := ADR(g);
    ps : POINTER TO S_P := ADR(st);
    pa : POINTER TO INT := ADR(arr[2]);
    rx : REF_TO INT := REF(x);
  END_VAR
  VAR_OUTPUT o : DINT; END_VAR
  IF bump THEN px^ := px^ + 1; END_IF;
  o := px^ + pg^ * 10 + ps^.a * 100 + pa^ * 1000 + rx^ * 100000;
END_FUNCTION_BLOCK

FUNCTION F_Check : DINT
  VAR_EXTERNAL g : INT; gs : STRING(8); pgl : POINTER TO INT; END_VAR
  VAR
    a : FB_A;
    b : FB_A;
    fault : DINT;
    y : INT := 7;
    py : POINTER TO INT := ADR(y);
    pgs : POINTER TO STRING(8) := ADR(gs);
  END_VAR
  (* each instance points at its own members *)
  a(bump := TRUE);
  b();
  IF a.o <> 4 + 50 + 400 + 20000 + 400000 THEN fault := fault + 1; END_IF;
  IF b.o <> 3 + 50 + 400 + 20000 + 300000 THEN fault := fault + 2; END_IF;
  (* a global, through a global and a local pointer *)
  IF pgl^ <> 5 OR pgs^ <> 'gg' THEN fault := fault + 4; END_IF;
  g := 6;
  b();
  IF b.o <> 3 + 60 + 400 + 20000 + 300000 OR pgl^ <> 6 THEN fault := fault + 8; END_IF;
  (* a function's own variable, for the call *)
  IF py^ <> 7 THEN fault := fault + 16; END_IF;
  F_Check := fault;
END_FUNCTION
`;

describeIfGpp("pointer and reference initializers", () => {
  it("point at the variable they name, per instance", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: `
TEST 'pointer initializers'
  ASSERT_EQ(F_Check(), 0);
END_TEST
`,
      testFileName: "test_pointer_initializers.st",
      tempDirPrefix: "strucpp-ptrinit-",
    });
    expect(stdout).toContain("[PASS] pointer initializers");
    expect(exitCode).toBe(0);
  });
});

describe("pointer and reference initializers refused", () => {
  const errors = (body: string): string[] =>
    compile(body).errors.map((e) => e.message);

  it("refuses an in-out, an outliving VAR_TEMP and REF() of a temporary", () => {
    expect(
      errors(`FUNCTION_BLOCK B
  VAR_IN_OUT io : INT; END_VAR
  VAR p : POINTER TO INT := ADR(io); END_VAR
END_FUNCTION_BLOCK`).some((m) => m.includes("in-out 'IO'")),
    ).toBe(true);
    expect(
      errors(`FUNCTION_BLOCK B
  VAR_TEMP t : INT; END_VAR
  VAR p : POINTER TO INT := ADR(t); END_VAR
END_FUNCTION_BLOCK`).some((m) => m.includes("VAR_TEMP 'T'")),
    ).toBe(true);
    expect(
      errors(`FUNCTION F : INT
  VAR x : INT; r : REF_TO INT := REF(x); END_VAR
  F := 0;
END_FUNCTION`).some((m) => m.includes("6.4.4.10.3")),
    ).toBe(true);
    expect(
      errors(`PROGRAM P
  VAR x : INT; p : POINTER TO INT := x; END_VAR
END_PROGRAM`).some((m) => m.includes("ADR(variable) or NULL")),
    ).toBe(true);
  });
});
