// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Two members of one block with one name are located errors, never a crash
 * (IEC 61131-3 6.1.2: identifiers are case-insensitive; 6.6.5.4.3 NOTE 1: no
 * overloading; a derived block changes a method with OVERRIDE). A method that
 * calls itself by its own name is a call, not its result variable.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const located = (src: string) =>
  compile(src).errors.map((e) => `${e.line}: ${e.message}`);

describe("duplicate members of one block", () => {
  it("locates a second method of the same name that calls itself", () => {
    const errors = located(`
FUNCTION_BLOCK FB_Y
  VAR n : INT; END_VAR
  METHOD PRIVATE X : INT
    X := 1;
  END_METHOD
  METHOD PRIVATE X : INT
    X := 0;
    IF X() = 1 THEN
      X := 2;
    END_IF;
  END_METHOD
  n := X();
END_FUNCTION_BLOCK
`);
    expect(errors).toEqual([
      "7: Method 'X' is already declared in 'FB_Y': identifiers are case-insensitive and methods cannot be overloaded (IEC 61131-3 6.1.2, 6.6.5.4.3 NOTE 1)",
    ]);
  });

  it("compiles a method that calls itself as a call", () => {
    const r = compile(`
FUNCTION_BLOCK FB_Y
  VAR n : INT; END_VAR
  METHOD PRIVATE Prod : INT
    VAR_INPUT k : INT; END_VAR
    IF k <= 1 THEN
      Prod := 1;
    ELSE
      Prod := k * Prod(k := k - 1);
    END_IF;
  END_METHOD
  n := Prod(k := 4);
END_FUNCTION_BLOCK
`);
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("PROD_result = K * PROD(K - 1);");
  });

  it("locates a second property of the same name", () => {
    expect(
      located(`
FUNCTION_BLOCK FB_Y
  VAR n : INT; END_VAR
  PROPERTY PUBLIC P : INT
    GET P := 1; END_GET
  END_PROPERTY
  PROPERTY PUBLIC P : INT
    GET P := 2; END_GET
  END_PROPERTY
  n := THIS^.P;
END_FUNCTION_BLOCK
`),
    ).toEqual([
      "7: Property 'P' is already declared in 'FB_Y': identifiers are case-insensitive (IEC 61131-3 6.1.2)",
    ]);
  });

  it("locates a property named like a method of the block", () => {
    expect(
      located(`
FUNCTION_BLOCK FB_Y
  VAR n : INT; END_VAR
  PROPERTY PUBLIC P : INT
    GET P := 1; END_GET
  END_PROPERTY
  METHOD PRIVATE P : INT
    P := 2;
  END_METHOD
  n := THIS^.P;
END_FUNCTION_BLOCK
`),
    ).toEqual([
      "4: Property 'P' of 'FB_Y' has the name of a method of the block: a property and a method of one block cannot share a name (IEC 61131-3 6.1.2)",
    ]);
  });
});
