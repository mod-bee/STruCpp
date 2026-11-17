/**
 * STruC++ Semantic Analyzer - Undefined Type Validation Tests
 *
 * Tests that undefined types are caught during semantic analysis
 * with proper error messages and source locations.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import { compile } from "../../src/index.js";
import { analyze } from "../../src/semantic/analyzer.js";

function analyzeSource(source: string) {
  const parseResult = parse(source);
  expect(parseResult.errors).toHaveLength(0);
  const ast = buildAST(parseResult.cst!);
  return analyze(ast);
}

// =============================================================================
// Positive Tests — no false errors for valid types
// =============================================================================

describe("Undefined Type Validation - Positive (no false errors)", () => {
  it("should accept elementary types", () => {
    const result = analyzeSource(`
      PROGRAM Main
        VAR
          b : BOOL;
          i : INT;
          d : DINT;
          r : REAL;
          lr : LREAL;
          s : STRING;
          w : WORD;
          t : TIME;
          dat : DATE;
        END_VAR
      END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept user-defined STRUCT types", () => {
    const result = analyzeSource(`
      TYPE MyStruct :
        STRUCT
          x : INT;
          y : REAL;
        END_STRUCT;
      END_TYPE

      PROGRAM Main
        VAR
          s : MyStruct;
        END_VAR
      END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept user-defined ENUM types", () => {
    const result = analyzeSource(`
      TYPE Color : (RED, GREEN, BLUE); END_TYPE

      PROGRAM Main
        VAR c : Color; END_VAR
      END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept FUNCTION_BLOCK types for instances", () => {
    const result = analyzeSource(`
      FUNCTION_BLOCK Counter
        VAR count : INT; END_VAR
      END_FUNCTION_BLOCK

      PROGRAM Main
        VAR c : Counter; END_VAR
      END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept POINTER TO / REF_TO with valid base type", () => {
    const result = analyzeSource(`
      PROGRAM Main
        VAR
          p : POINTER TO INT;
          r : REF_TO REAL;
        END_VAR
      END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept inline ARRAY OF with valid element type", () => {
    const result = analyzeSource(`
      PROGRAM Main
        VAR
          arr : ARRAY[0..9] OF INT;
        END_VAR
      END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept forward references (types declared after use in same unit)", () => {
    // In IEC 61131-3, all types are registered before validation runs
    const result = analyzeSource(`
      PROGRAM Main
        VAR s : MyStruct; END_VAR
      END_PROGRAM

      TYPE MyStruct :
        STRUCT
          x : INT;
        END_STRUCT;
      END_TYPE
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept interface names as types", () => {
    const result = analyzeSource(`
      INTERFACE IRunnable
        METHOD Run : BOOL
        END_METHOD
      END_INTERFACE

      FUNCTION_BLOCK Motor IMPLEMENTS IRunnable
        METHOD PUBLIC Run : BOOL
        END_METHOD
      END_FUNCTION_BLOCK

      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept case-insensitive type names", () => {
    const result = analyzeSource(`
      TYPE MyStruct :
        STRUCT
          x : INT;
        END_STRUCT;
      END_TYPE

      PROGRAM Main
        VAR s : mystruct; END_VAR
      END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept function return type VOID (implicit)", () => {
    const result = analyzeSource(`
      FUNCTION Add : INT
        VAR_INPUT a : INT; b : INT; END_VAR
      END_FUNCTION

      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("should accept programs used as types in CONFIGURATION", () => {
    const result = analyzeSource(`
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });
});

// =============================================================================
// Negative Tests — must report errors for undefined types
// =============================================================================

describe("Undefined Type Validation - Negative (must error)", () => {
  it("should error on undefined type in variable declaration", () => {
    const result = analyzeSource(`
      PROGRAM Main
        VAR x : NonExistentType; END_VAR
      END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/NonExistentType/i);
  });

  it("should error on undefined function return type", () => {
    const result = analyzeSource(`
      FUNCTION Foo : UnknownReturnType
      END_FUNCTION
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/UnknownReturnType/i);
  });

  it("should error on undefined method return type", () => {
    const result = analyzeSource(`
      FUNCTION_BLOCK MyFB
        METHOD PUBLIC Calc : MissingType
        END_METHOD
      END_FUNCTION_BLOCK
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/MissingType/i);
  });

  it("should error on undefined type in struct field", () => {
    const result = analyzeSource(`
      TYPE MyStruct :
        STRUCT
          x : INT;
          y : GhostType;
        END_STRUCT;
      END_TYPE
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/GhostType/i);
  });

  it("should error on undefined type in EXTENDS clause", () => {
    const result = analyzeSource(`
      FUNCTION_BLOCK Child EXTENDS NonExistentParent
      END_FUNCTION_BLOCK
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/NonExistentParent/i);
  });

  it("should error on undefined type in IMPLEMENTS clause", () => {
    const result = analyzeSource(`
      FUNCTION_BLOCK MyFB IMPLEMENTS IDoesNotExist
        METHOD PUBLIC Dummy : BOOL
        END_METHOD
      END_FUNCTION_BLOCK
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/IDoesNotExist/i);
  });

  it("should error on undefined type in ARRAY element type", () => {
    const result = analyzeSource(`
      PROGRAM Main
        VAR arr : ARRAY[0..5] OF MysteryType; END_VAR
      END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/MysteryType/i);
  });

  it("should error on undefined type in function parameter", () => {
    const result = analyzeSource(`
      FUNCTION Foo : INT
        VAR_INPUT x : UnknownParam; END_VAR
      END_FUNCTION
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/UnknownParam/i);
  });

  it("should error on undefined type in method parameter", () => {
    const result = analyzeSource(`
      FUNCTION_BLOCK MyFB
        METHOD PUBLIC DoWork : INT
          VAR_INPUT p : NoSuchType; END_VAR
        END_METHOD
      END_FUNCTION_BLOCK
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/NoSuchType/i);
  });

  it("should error on undefined type in POINTER TO", () => {
    const result = analyzeSource(`
      PROGRAM Main
        VAR p : POINTER TO FakeType; END_VAR
      END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/FakeType/i);
  });

  it("should error on undefined type in interface EXTENDS", () => {
    const result = analyzeSource(`
      INTERFACE IChild EXTENDS IDoesNotExist
        METHOD Foo : BOOL
        END_METHOD
      END_INTERFACE
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/IDoesNotExist/i);
  });

  it("should error on undefined type in property type", () => {
    const result = analyzeSource(`
      FUNCTION_BLOCK MyFB
        VAR _val : INT; END_VAR
        PROPERTY PUBLIC Value : NoType
          GET
            Value := _val;
          END_GET
        END_PROPERTY
      END_FUNCTION_BLOCK
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain("Undefined type");
    expect(result.errors[0]!.message).toMatch(/NoType/i);
  });

  it("should report multiple undefined types", () => {
    const result = analyzeSource(`
      PROGRAM Main
        VAR
          a : TypeA;
          b : TypeB;
        END_VAR
      END_PROGRAM
    `);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const messages = result.errors.map((e) => e.message);
    expect(messages.some((m) => /TypeA/i.test(m))).toBe(true);
    expect(messages.some((m) => /TypeB/i.test(m))).toBe(true);
  });
});

// =============================================================================
// Source Location Tests
// =============================================================================

describe("Undefined Type Validation - Source Location", () => {
  it("should report correct line number for undefined type", () => {
    const result = analyzeSource(
      `PROGRAM Main
VAR
  x : INT;
  y : BadType;
END_VAR
END_PROGRAM`,
    );
    expect(result.errors.length).toBeGreaterThan(0);
    const err = result.errors.find((e) => /BadType/i.test(e.message));
    expect(err).toBeDefined();
    expect(err!.line).toBe(4);
  });
});

// =============================================================================
// Multi-Source Tests — a type error in one file must not silence another
// =============================================================================

describe("Undefined Type Validation - Multi-Source", () => {
  const typesST = `
    TYPE MyStruct :
      STRUCT
        field1 : Foo;
      END_STRUCT;
    END_TYPE
  `;

  it("should report an undefined type while another source fails type checking", () => {
    // `x : Foo` also makes the IF condition a type error. That error used to run
    // first and suppress every undefined-type report in the whole project.
    const mainST = `
      PROGRAM Main
        VAR
          x : Foo;
        END_VAR
        IF x THEN
          ;
        END_IF;
      END_PROGRAM
    `;

    const result = compile(mainST, {
      additionalSources: [{ source: typesST, fileName: "types.st" }],
    });

    const undefinedTypeErrors = result.errors.filter((e) =>
      /Undefined type/i.test(e.message),
    );
    expect(undefinedTypeErrors.length).toBeGreaterThan(0);
    expect(undefinedTypeErrors.some((e) => /STRUCT/i.test(e.message))).toBe(
      true,
    );
  });

  it("should not let an undefined type suppress unrelated diagnostics", () => {
    const mainST = `
      PROGRAM Main
        VAR
          x : Foo;
          ok : BOOL;
        END_VAR
        ok := neverDeclared;
      END_PROGRAM
    `;

    const result = compile(mainST, {});

    expect(result.errors.some((e) => /Undefined type/i.test(e.message))).toBe(
      true,
    );
    expect(
      result.errors.some((e) => /Undeclared variable/i.test(e.message)),
    ).toBe(true);
  });

  it("should report an undefined type when the other source is clean", () => {
    const mainST = `
      PROGRAM Main
      END_PROGRAM
    `;

    const result = compile(mainST, {
      additionalSources: [{ source: typesST, fileName: "types.st" }],
    });

    const undefinedTypeErrors = result.errors.filter((e) =>
      /Undefined type/i.test(e.message),
    );
    expect(undefinedTypeErrors.length).toBeGreaterThan(0);
    expect(undefinedTypeErrors.some((e) => /Foo/i.test(e.message))).toBe(true);
  });
});

// =============================================================================
// Every place a type is named: an unknown one is a semantic error, never a C++ build failure
// (2026-11-17: `aZones : ARRAY[*] OF FB_Zone` with FB_Zone missing passed and broke g++)
// =============================================================================

describe("Undefined Type Validation - every declaration site", () => {
  const cases: Array<[string, string]> = [
    [
      "a variable-length array element in an FB in-out",
      `FUNCTION_BLOCK FB_A
         VAR_IN_OUT aZones : ARRAY[*] OF FB_Missing; END_VAR
       END_FUNCTION_BLOCK`,
    ],
    [
      "a variable-length array element in a FUNCTION in-out",
      `FUNCTION F_A : INT
         VAR_IN_OUT a : ARRAY[*] OF FB_Missing; END_VAR
         F_A := 0;
       END_FUNCTION`,
    ],
    [
      "a variable-length array element in a METHOD in-out",
      `FUNCTION_BLOCK FB_A
         METHOD M : INT
           VAR_IN_OUT a : ARRAY[*] OF FB_Missing; END_VAR
           M := 0;
         END_METHOD
       END_FUNCTION_BLOCK`,
    ],
    [
      "a multi-dimensional variable-length array element",
      `FUNCTION F_A : INT
         VAR_IN_OUT a : ARRAY[*, *] OF FB_Missing; END_VAR
         F_A := 0;
       END_FUNCTION`,
    ],
    [
      "an FB instance",
      `FUNCTION_BLOCK FB_A
         VAR fb : FB_Missing; END_VAR
       END_FUNCTION_BLOCK`,
    ],
    [
      "a STRUCT member array",
      `TYPE ST_A : STRUCT a : ARRAY[1..4] OF FB_Missing; END_STRUCT; END_TYPE`,
    ],
    [
      "a STRUCT member REFERENCE TO",
      `TYPE ST_A : STRUCT r : REFERENCE TO ST_Missing; END_STRUCT; END_TYPE`,
    ],
    [
      "a REFERENCE TO variable",
      `FUNCTION_BLOCK FB_A
         VAR_INPUT refData : REFERENCE TO ST_Missing; END_VAR
       END_FUNCTION_BLOCK`,
    ],
    [
      "a POINTER TO an array element",
      `PROGRAM Main
         VAR p : POINTER TO ARRAY[1..2] OF ST_Missing; END_VAR
       END_PROGRAM`,
    ],
    [
      "an array of POINTER TO",
      `PROGRAM Main
         VAR a : ARRAY[1..2] OF POINTER TO ST_Missing; END_VAR
       END_PROGRAM`,
    ],
    [
      "an interface pin",
      `FUNCTION_BLOCK FB_A
         VAR_INPUT ipOwner : I_Missing; END_VAR
       END_FUNCTION_BLOCK`,
    ],
    [
      "an interface method parameter",
      `INTERFACE I_A
         METHOD M : INT
           VAR_INPUT ipX : I_Missing; END_VAR
         END_METHOD
       END_INTERFACE`,
    ],
    [
      "an interface property",
      `INTERFACE I_A
         PROPERTY eX : E_Missing
           GET END_GET
         END_PROPERTY
       END_INTERFACE`,
    ],
    [
      "a type alias",
      `TYPE T_A : FB_Missing; END_TYPE`,
    ],
    [
      "an array type",
      `TYPE T_A : ARRAY[1..3] OF ST_Missing; END_TYPE`,
    ],
    [
      "a VAR_GLOBAL",
      `VAR_GLOBAL g : ST_Missing; END_VAR`,
    ],
    [
      "a method local",
      `FUNCTION_BLOCK FB_A
         METHOD M : INT
           VAR x : ST_Missing; END_VAR
           M := 0;
         END_METHOD
       END_FUNCTION_BLOCK`,
    ],
  ];
  for (const [where, src] of cases) {
    it(`should error on an undefined type in ${where}`, () => {
      const result = analyzeSource(`${src}\nPROGRAM Main_X END_PROGRAM`);
      const undefinedTypeErrors = result.errors.filter((e) => e.message.includes("Undefined type"));
      expect(undefinedTypeErrors.length, where).toBeGreaterThan(0);
      expect(undefinedTypeErrors.some((e) => /_Missing/i.test(e.message)), where).toBe(true);
    });
  }

  it("should accept a variable-length array of a declared FB", () => {
    const result = analyzeSource(`
      FUNCTION_BLOCK FB_Zone END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_Seq
        VAR_IN_OUT aZones : ARRAY[*] OF FB_Zone; END_VAR
      END_FUNCTION_BLOCK
      PROGRAM Main END_PROGRAM
    `);
    expect(result.errors).toHaveLength(0);
  });
});

describe("Undefined Type Validation - a variable-length array through compile()", () => {
  it("fails the compile with the semantic error, before any C++ is generated", () => {
    // The field case: a sequencer over the project's zones, with FB_Zone's file missing.
    const seqST = `
      FUNCTION_BLOCK FB_ZoneSeq
        VAR_IN_OUT
          aZones : ARRAY[*] OF FB_Zone;
        END_VAR
        METHOD PRIVATE Count : INT
          VAR_IN_OUT
            aZ : ARRAY[*] OF FB_Zone;
          END_VAR
          Count := 0;
        END_METHOD
      END_FUNCTION_BLOCK
    `;
    const result = compile(`PROGRAM Main END_PROGRAM`, {
      additionalSources: [{ source: seqST, fileName: "FB_ZoneSeq.st" }],
    });
    expect(result.success).toBe(false);
    const undefinedTypeErrors = result.errors.filter((e) => /Undefined type/i.test(e.message));
    expect(undefinedTypeErrors.length).toBe(2);
    expect(undefinedTypeErrors.every((e) => /FB_ZONE/i.test(e.message))).toBe(true);
    expect(undefinedTypeErrors.every((e) => e.file === "FB_ZoneSeq.st")).toBe(true);
  });
});
