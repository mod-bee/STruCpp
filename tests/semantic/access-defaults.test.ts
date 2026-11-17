// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Access when no specifier is written:
 *
 * - a method is PUBLIC, as in CODESYS and TwinCAT ("Object: Method"); IEC
 *   61131-3 Ed.3 makes it PROTECTED (6.6.5.4.3 rule 5, 6.6.5.9);
 * - a VAR section is PROTECTED (6.6.5.10, 6.6.7.2.6); inputs and outputs are
 *   always PUBLIC;
 * - a method implementing an interface prototype must be PUBLIC (6.6.6.4.2
 *   rule 3): one without a specifier is.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";

const errorsOf = (source: string): string[] =>
  compile(source).errors.map((e) => e.message);

const BLOCK = `
FUNCTION_BLOCK B
  VAR_INPUT i : INT; END_VAR
  VAR_OUTPUT o : INT; END_VAR
  VAR hidden : INT; END_VAR
  VAR PUBLIC shown : INT; END_VAR
  METHOD Plain : INT Plain := hidden; END_METHOD
  METHOD PROTECTED Inner : INT Inner := hidden; END_METHOD
  METHOD PUBLIC Open : INT Open := THIS.Plain(); END_METHOD
  o := i + THIS.Plain();
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  METHOD PUBLIC Twice : INT Twice := 2 * THIS.Plain() + hidden; END_METHOD
END_FUNCTION_BLOCK`;

const program = (body: string): string =>
  `${BLOCK}\nPROGRAM P VAR b : B; d : D; x : INT; END_VAR\n${body}\nEND_PROGRAM`;

describe("access when no specifier is written (CODESYS methods; IEC 61131-3 6.6.5.10 VAR)", () => {
  it("lets the block and a derived block call the method and read the VAR", () => {
    expect(
      errorsOf(program("x := b.Open() + d.Twice() + b.o + b.shown;")),
    ).toEqual([]);
  });

  it("lets a program call the unspecified method", () => {
    expect(errorsOf(program("x := b.Plain();"))).toEqual([]);
  });

  it("refuses a read of the unspecified VAR from a program", () => {
    expect(errorsOf(program("x := b.hidden;")).join("\n")).toMatch(
      /hidden' is a PROTECTED \(the default\) variable/i,
    );
  });

  it("takes an interface implementation without a specifier, refuses a PROTECTED one", () => {
    expect(
      errorsOf(`
INTERFACE I METHOD M : INT END_METHOD END_INTERFACE
FUNCTION_BLOCK F IMPLEMENTS I
  METHOD M : INT M := 1; END_METHOD
END_FUNCTION_BLOCK`),
    ).toEqual([]);
    const errors = errorsOf(`
INTERFACE I METHOD M : INT END_METHOD END_INTERFACE
FUNCTION_BLOCK F IMPLEMENTS I
  METHOD PROTECTED M : INT M := 1; END_METHOD
END_FUNCTION_BLOCK`);
    expect(errors.join("\n")).toMatch(/must be PUBLIC/);
  });

  it("publishes every method of a library block with its access", () => {
    const lib = compileStlib([{ source: BLOCK, fileName: "b.st" }], {
      name: "acc",
      version: "1.0.0",
      namespace: "acc",
    });
    expect(lib.errors).toEqual([]);
    const b = lib.archive.manifest.functionBlocks.find((f) => f.name === "B")!;
    expect((b.methods ?? []).map((m) => [m.name, m.visibility])).toEqual([
      ["PLAIN", "PUBLIC"],
      ["INNER", "PROTECTED"],
      ["OPEN", "PUBLIC"],
    ]);
  });
});
