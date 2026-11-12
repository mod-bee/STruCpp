// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Fixes of gaps found while proving the OOP features end to end. Each case
 * names the clause of IEC 61131-3 Ed.3 or the CODESYS online help page that
 * defines the behaviour.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import {
  CXX_STD,
  cxxEnv,
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  runE2ETestPipeline,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const errorsOf = (src: string): string[] =>
  compile(src).errors.map((e) => e.message);

const run = (sourceST: string, testST: string, name: string) =>
  runE2ETestPipeline({
    sourceST,
    testST,
    testFileName: `test_${name}.st`,
    tempDirPrefix: `strucpp-bugfix-${name}-`,
  });

// IEC 61131-3 6.6.5.7.2: THIS is the own instance; a member path follows it.
// CODESYS writes it THIS^.
describeIfGpp("a path from THIS", () => {
  it("reads and writes members, elements and nested instances", () => {
    const { stdout, exitCode } = run(
      `
TYPE ST : STRUCT n : INT; arr : ARRAY[1..3] OF INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_In
  VAR_OUTPUT q : INT; END_VAR
  METHOD PUBLIC Twice : INT Twice := q * 2; END_METHOD
  q := q + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB
  VAR_OUTPUT k : INT; END_VAR
  VAR s : ST; a : ARRAY[1..3] OF INT; inner : FB_In; END_VAR
  THIS.s.n := 5;
  THIS^.s.arr[2] := 6;
  THIS.a[1] := 7;
  THIS^.inner();
  k := THIS.s.n + THIS^.a[1] + THIS.s.arr[2] + THIS.inner.q + THIS^.inner.Twice();
END_FUNCTION_BLOCK
`,
      `
TEST 'THIS paths'
  VAR f : FB; END_VAR
  f();
  ASSERT_EQ(f.k, 21);
END_TEST
`,
      "this_path",
    );
    expect(stdout).toContain("[PASS] THIS paths");
    expect(exitCode).toBe(0);
  });
});

// IEC 61131-3 6.4.4.10.3: "A dereferenced reference can be used in the same
// way as using a variable directly" - a REF_TO a block is called with `r^()`.
describeIfGpp("a block called through a dereferenced reference", () => {
  it("runs rf^(), rf^(in := v), s.r^() and arr[i]^()", () => {
    const { stdout, exitCode } = run(
      `
FUNCTION_BLOCK FB_T
  VAR_INPUT inc : INT := 1; END_VAR
  VAR_OUTPUT q : INT; END_VAR
  q := q + inc;
END_FUNCTION_BLOCK
TYPE ST : STRUCT r : REF_TO FB_T; END_STRUCT END_TYPE
FUNCTION F_Calls : INT
  VAR f : FB_T; rf : REF_TO FB_T; s : ST; arr : ARRAY[1..2] OF REF_TO FB_T; END_VAR
  rf := REF(f);
  rf^();
  rf^(inc := 5);
  s.r := REF(f);
  s.r^(inc := 10);
  arr[2] := REF(f);
  arr[2]^();
  F_Calls := rf^.q;
END_FUNCTION
`,
      `
TEST 'calls through REF_TO'
  ASSERT_EQ(F_Calls(), 26);  (* 1 + 5 + 10 + 10: an input keeps its last value *)
END_TEST
`,
      "ref_call",
    );
    expect(stdout).toContain("[PASS] calls through REF_TO");
    expect(exitCode).toBe(0);
  });
});

// IEC 61131-3 6.5.2.2 (VAR_GLOBAL): a global may be of any type, a function
// block included. The C++ variable needs its class complete first.
describeIfGpp("a top-level VAR_GLOBAL of a block type", () => {
  it("is emitted after its class and runs", () => {
    const { stdout, exitCode } = run(
      `
FUNCTION_BLOCK FB_X
  VAR_INPUT x : INT := 3; END_VAR
  VAR_OUTPUT q : INT; END_VAR
  q := q + x;
END_FUNCTION_BLOCK
VAR_GLOBAL
  gx : FB_X := (x := 9);
  ga : ARRAY[1..2] OF FB_X;
  gn : INT := 4;
END_VAR
FUNCTION F_Global : INT
  gx();
  ga[2](x := gn);
  F_Global := gx.q + ga[2].q;
END_FUNCTION
`,
      `
TEST 'block-typed globals'
  ASSERT_EQ(F_Global(), 13);
END_TEST
`,
      "fb_global",
    );
    expect(stdout).toContain("[PASS] block-typed globals");
    expect(exitCode).toBe(0);
  });
});

// A TEST variable is declared like any variable (IEC 61131-3 6.5.1): a
// POINTER TO / REF_TO a block is a pointer, not an instance.
describeIfGpp("pointers and references in TEST variables", () => {
  it("declares POINTER TO and REF_TO a block as pointers", () => {
    const { stdout, exitCode } = run(
      `
FUNCTION_BLOCK FB_C
  VAR_OUTPUT n : INT; END_VAR
  METHOD PUBLIC Bump : INT n := n + 1; Bump := n; END_METHOD
END_FUNCTION_BLOCK
`,
      `
TEST 'pointer test variables'
  VAR p : POINTER TO FB_C; r : REF_TO FB_C; f : FB_C; k : INT; END_VAR
  p := __NEW(FB_C);
  k := p^.Bump();
  k := p^.Bump();
  ASSERT_EQ(k, 2);
  __DELETE(p);
  r := REF(f);
  r^.Bump();
  ASSERT_EQ(f.n, 1);
END_TEST
`,
      "test_ptr",
    );
    expect(stdout).toContain("[PASS] pointer test variables");
    expect(exitCode).toBe(0);
  });
});

// IEC 61131-3 6.5.1: an initial value names declared variables, constants
// and enumeration values only; an unknown name is an error, as in a body.
describe("names in initial values", () => {
  it("refuses an undeclared name", () => {
    expect(
      errorsOf(`
TYPE S : STRUCT n : INT := nofield; END_STRUCT END_TYPE
VAR_GLOBAL g : INT := noglobal; END_VAR
FUNCTION_BLOCK FB_I
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; a : INT; END_VAR
  END_METHOD
  METHOD PUBLIC M : INT
    VAR k : INT := nomethodvar; END_VAR
    M := k;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
  VAR
    x : INT := nosuch;
    arr : ARRAY[1..2] OF INT := [1, noelement];
    f : FB_I(a := noarg);
  END_VAR
END_PROGRAM
`),
    ).toEqual([
      "Undeclared variable 'NOGLOBAL'",
      "Undeclared variable 'NOFIELD'",
      "Undeclared variable 'NOSUCH'",
      "Undeclared variable 'NOELEMENT'",
      "Undeclared variable 'NOARG'",
      "Undeclared variable 'NOMETHODVAR'",
    ]);
  });

  it("accepts constants, enumeration values and typed literals", () => {
    expect(
      errorsOf(`
TYPE E : (EA, EB) := EA; END_TYPE
TYPE U : USINT (UA := 1, UB := 2) := UA; END_TYPE
VAR_GLOBAL CONSTANT gMax : INT := 10; END_VAR
FUNCTION_BLOCK FB_C
  VAR CONSTANT c : INT := 3; END_VAR
  VAR
    a : INT := c + gMax;
    e1 : E := EB;
    e2 : E := E.EA;
    e3 : E := E#EB;
    u : U;
    e : E;
  END_VAR
END_FUNCTION_BLOCK
`),
    ).toEqual([]);
  });
});

// CODESYS "Object: Property": a library's interface property is part of the
// interface a consumer implements and uses.
describeIfGpp("a library interface's properties", () => {
  const lib = () => {
    const built = compileStlib(
      [
        {
          fileName: "parts.st",
          source: `
INTERFACE I_Part
  PROPERTY nVal : INT END_PROPERTY
  PROPERTY bReady : BOOL GET END_GET END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB_LibPart IMPLEMENTS I_Part
  VAR n : INT; END_VAR
  PROPERTY PUBLIC nVal : INT
    GET nVal := n; END_GET
    SET n := nVal; END_SET
  END_PROPERTY
  PROPERTY PUBLIC bReady : BOOL
    GET bReady := n > 2; END_GET
  END_PROPERTY
END_FUNCTION_BLOCK
`,
        },
      ],
      { name: "parts-lib", version: "1.0.0", namespace: "partslib" },
    );
    expect(built.errors).toEqual([]);
    return JSON.parse(JSON.stringify(built.archive)) as StlibArchive;
  };

  it("are in the manifest, implemented and used by a consumer", () => {
    const archive = lib();
    expect(archive.manifest.interfaces?.[0]?.properties).toEqual([
      { type: { name: "NVAL", type: "INT" }, get: true, set: true },
      { type: { name: "BREADY", type: "BOOL" }, get: true, set: false },
    ]);
    const source = `
FUNCTION_BLOCK FB_Mine IMPLEMENTS I_Part
  VAR n : INT := 7; END_VAR
  PROPERTY PUBLIC nVal : INT
    GET nVal := n * 10; END_GET
    SET n := nVal; END_SET
  END_PROPERTY
  PROPERTY PUBLIC bReady : BOOL
    GET bReady := TRUE; END_GET
  END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION F_Parts : INT
  VAR a : FB_LibPart; m : FB_Mine; i : I_Part; END_VAR
  i := a;
  i.nVal := 3;
  IF i.bReady THEN F_Parts := i.nVal; END_IF
  i := m;
  F_Parts := F_Parts + i.nVal;
END_FUNCTION
`;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: source,
      testST: `
TEST 'library interface properties'
  ASSERT_EQ(F_Parts(), 73);
END_TEST
`,
      testFileName: "test_lib_iface_props.st",
      tempDirPrefix: "strucpp-lib-iface-props-",
      compileOptions: { libraries: [archive] },
    });
    expect(stdout).toContain("[PASS] library interface properties");
    expect(exitCode).toBe(0);
    expect(
      compile(
        `FUNCTION_BLOCK FB_Bad IMPLEMENTS I_Part
  PROPERTY PUBLIC nVal : INT GET nVal := 1; END_GET END_PROPERTY
END_FUNCTION_BLOCK`,
        { libraries: [archive] },
      ).errors.map((e) => e.message),
    ).toEqual([
      "Property 'NVAL' of 'FB_BAD' needs SET: INTERFACE 'I_PART' declares it",
      "FUNCTION_BLOCK 'FB_BAD' does not implement property 'BREADY' of INTERFACE 'I_PART'",
    ]);
  });
});

// CODESYS "Object: Property": a property is used like a variable of its type,
// so reading and writing one is type-checked like a variable.
describe("property reads and writes are type-checked", () => {
  const SRC = (body: string) => `
INTERFACE I_P PROPERTY nVal : INT END_PROPERTY END_INTERFACE
FUNCTION_BLOCK FB_P IMPLEMENTS I_P
  VAR n : INT; END_VAR
  PROPERTY PUBLIC nVal : INT GET nVal := n; END_GET SET n := nVal; END_SET END_PROPERTY
  PROPERTY PUBLIC sName : STRING GET sName := 'x'; END_GET END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Q EXTENDS FB_P END_FUNCTION_BLOCK
PROGRAM P
  VAR f : FB_P; q : FB_Q; i : I_P; b : BOOL; k : INT; s : STRING; END_VAR
  ${body}
END_PROGRAM
`;
  it("refuses a property of the wrong type, own, inherited or through an interface", () => {
    expect(errorsOf(SRC("k := q.sName; f.nVal := 'text'; i.nVal := s;"))).toEqual([
      "Cannot assign STRING to INT",
      "Cannot assign STRING to INT",
      "Cannot assign STRING to INT",
    ]);
  });
  it("accepts and warns as for a variable", () => {
    const r = compile(SRC("k := f.nVal + i.nVal; s := q.sName; b := f.nVal;"));
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toContain(
      "Implicit narrowing conversion from INT to BOOL",
    );
  });
});

// A block nothing can override binds its methods statically (d85b49b,
// method-dead-strip-cpp.test.ts); its property accessors likewise. An
// accessor an interface declares, or one a derived block may replace, stays
// virtual. The names are unchanged: get_NAME() const / set_NAME(T NAME).
describe("property accessors of a sealed block", () => {
  const SRC = `
INTERFACE I_P PROPERTY nVal : INT END_PROPERTY END_INTERFACE
FUNCTION_BLOCK FB_Sealed
  VAR n : INT := 4; END_VAR
  PROPERTY PUBLIC bp1 : INT GET bp1 := n; END_GET SET n := bp1; END_SET END_PROPERTY
  PROPERTY PUBLIC bp2 : INT GET bp2 := n * 2; END_GET END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Iface IMPLEMENTS I_P
  VAR n : INT; END_VAR
  PROPERTY PUBLIC nVal : INT GET nVal := n; END_GET SET n := nVal; END_SET END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Base
  PROPERTY PUBLIC k : INT GET k := 1; END_GET END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Derived EXTENDS FB_Base
END_FUNCTION_BLOCK
PROGRAM Main
  VAR s : FB_Sealed; f : FB_Iface; d : FB_Derived; r : INT; END_VAR
  s.bp1 := 20;
  r := s.bp1 + d.k;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

  it("are plain member functions; an interface's or a base's stay virtual", () => {
    const result = compile(SRC, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const accessors = result.headerCode
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /\b(get|set)_[A-Z0-9]+\(/.test(l));
    expect(accessors).toEqual([
      "virtual IEC_INT get_NVAL() const = 0;",
      "virtual void set_NVAL(IEC_INT NVAL) = 0;",
      "IEC_INT get_BP1() const;",
      "void set_BP1(IEC_INT BP1);",
      "IEC_INT get_BP2() const;",
      "virtual IEC_INT get_NVAL() const;",
      "virtual void set_NVAL(IEC_INT NVAL);",
      "virtual IEC_INT get_K() const;",
    ]);
  });

  (hasGpp ? it : it.skip)("drops an unused accessor at link time", () => {
    const result = compile(SRC, { headerFileName: "generated.hpp" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-prop-seal-"));
    try {
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(dir, "main.cpp"),
        `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  std::printf(p.R == 21 ? "ALL_OK\\n" : "FAIL r=%d\\n", (int)p.R);
  return p.R == 21 ? 0 : 1;
}
`,
      );
      const bin = path.join(dir, "seal");
      execSync(
        `g++ -std=${CXX_STD} -O1 -ffunction-sections -fdata-sections -Wl,--gc-sections ` +
          `-I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
          `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
      expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
      const symbols = execSync(`nm -C "${bin}"`, { encoding: "utf-8" });
      expect(symbols).not.toContain("FB_SEALED::get_BP2");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
