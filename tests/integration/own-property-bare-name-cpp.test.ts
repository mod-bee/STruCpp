// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A block reads and writes its own property by its bare name, as CODESYS
 * allows (IEC 61131-3 Ed.3 has no properties; CODESYS online help, "Object:
 * Property": a property is used like a variable of the block).
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const REPRO = `
FUNCTION_BLOCK FB_A
  VAR
    x : INT := 3;
    y : INT;
  END_VAR
  PROPERTY PUBLIC P : INT
    GET
      P := x;
    END_GET
  END_PROPERTY
  METHOD PUBLIC M : INT
    M := P + 1;
  END_METHOD
  y := P;
END_FUNCTION_BLOCK
`;

describe("a block's own property by its bare name", () => {
  it("compiles the smallest case to the getter", () => {
    const r = compile(REPRO);
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.cppCode).toContain("Y = this->get_P();");
    expect(r.cppCode).toContain("M_result = this->get_P() + 1;");
  });

  it("keeps the property's own name as its result inside its accessor", () => {
    const r = compile(REPRO);
    expect(r.cppCode).not.toMatch(/get_P\(\)\s*\{[^}]*get_P\(\)/);
  });

  it("still refuses a name that is neither a variable nor a property", () => {
    const r = compile(REPRO.replace("y := P;", "y := Q;"));
    expect(r.errors.map((e) => e.message)).toContain("Undeclared variable 'Q'");
  });
});

describeIfGpp("a block's own property by its bare name, run", () => {
  it("reads and writes its own and an inherited property", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `
FUNCTION_BLOCK FB_Base
  VAR
    nStore : INT := 4;
  END_VAR
  PROPERTY PUBLIC Base : INT
    GET
      Base := nStore * 10;
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Own EXTENDS FB_Base
  VAR_OUTPUT
    nRead : INT;
    nInMethod : INT;
    nInherited : INT;
  END_VAR
  VAR
    nVal : INT;
  END_VAR
  PROPERTY PUBLIC Val : INT
    GET
      Val := nVal;
    END_GET
    SET
      nVal := Val * 2;
    END_SET
  END_PROPERTY
  PROPERTY PUBLIC Twice : INT
    GET
      Twice := Val + Val;
    END_GET
  END_PROPERTY
  METHOD PUBLIC Plus : INT
    VAR_INPUT
      n : INT;
    END_VAR
    Plus := Val + n;
  END_METHOD
  Val := 5;
  nRead := Val;
  nInMethod := Plus(n := 1) + Twice;
  nInherited := Base;
END_FUNCTION_BLOCK
`,
      testST: `
TEST 'own property by bare name'
  VAR f : FB_Own; END_VAR
  f();
  ASSERT_EQ(f.nRead, 10);
  ASSERT_EQ(f.nInMethod, 31);
  ASSERT_EQ(f.nInherited, 40);
END_TEST
`,
      testFileName: "test_own_property.st",
      tempDirPrefix: "strucpp-own-property-",
    });
    expect(stdout).toContain("[PASS] own property by bare name");
    expect(exitCode).toBe(0);
  });
});
