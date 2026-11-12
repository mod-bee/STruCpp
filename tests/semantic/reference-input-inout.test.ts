/**
 * A VAR_INPUT may not be passed to an in-out: the callee may write to it.
 * A REFERENCE TO / REF_TO input is different: it names the variable it refers
 * to, so that variable (or a member or element of it) may be passed to an
 * in-out, as CODESYS allows ("REFERENCE TO", "Pointer: POINTER TO").
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SRC = (body: string) => `
TYPE St : STRUCT a : INT; inner : STRUCT2; END_STRUCT; END_TYPE
TYPE STRUCT2 : STRUCT b : INT; END_STRUCT; END_TYPE
FUNCTION Bump : BOOL
VAR_IN_OUT io : INT; END_VAR
io := io + 1;
Bump := TRUE;
END_FUNCTION
FUNCTION BumpS : BOOL
VAR_IN_OUT s : St; END_VAR
s.a := s.a + 1;
BumpS := TRUE;
END_FUNCTION
FUNCTION_BLOCK FB_T
VAR_INPUT
  refS : REFERENCE TO St;
  pS : REF_TO St;
  nPlain : INT;
END_VAR
VAR x : BOOL; END_VAR
${body}
END_FUNCTION_BLOCK
`;

function errors(body: string): string[] {
  return compile(SRC(body)).errors.map((e) => e.message);
}

describe("in-out actuals through a REFERENCE TO / REF_TO input", () => {
  it("accepts a member of a REFERENCE TO input", () => {
    expect(errors("x := Bump(io := refS.a);")).toEqual([]);
  });

  it("accepts a nested member of a REFERENCE TO input", () => {
    expect(errors("x := Bump(io := refS.inner.b);")).toEqual([]);
  });

  it("accepts the whole referenced variable", () => {
    expect(errors("x := BumpS(s := refS);")).toEqual([]);
  });

  it("accepts a member of a dereferenced REF_TO input", () => {
    expect(errors("x := Bump(io := pS^.a);")).toEqual([]);
  });

  it("still refuses a plain VAR_INPUT", () => {
    expect(errors("x := Bump(io := nPlain);")).toEqual([
      "'NPLAIN' is a VAR_INPUT and cannot be assigned to in-out 'IO' of 'BUMP' — the callee may write to it",
    ]);
  });
});
