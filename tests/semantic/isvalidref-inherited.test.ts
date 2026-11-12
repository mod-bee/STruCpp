/**
 * __ISVALIDREF (CODESYS "Operator: __ISVALIDREF") takes a variable declared
 * REFERENCE TO — also one a block inherits from its base (EXTENDS).
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SRC = (body: string) => `
TYPE St : STRUCT a : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_Base
VAR_INPUT
  refS : REFERENCE TO St;
  n : INT;
END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Child EXTENDS FB_Base
VAR x : BOOL; END_VAR
${body}
END_FUNCTION_BLOCK
`;

function errors(body: string): string[] {
  return compile(SRC(body)).errors.map((e) => e.message);
}

describe("__ISVALIDREF on an inherited REFERENCE TO", () => {
  it("accepts a REFERENCE TO input inherited from the base", () => {
    expect(errors("x := __ISVALIDREF(refS);")).toEqual([]);
  });

  it("still refuses an inherited variable that is not a reference", () => {
    expect(errors("x := __ISVALIDREF(n);")).toHaveLength(1);
  });
});
