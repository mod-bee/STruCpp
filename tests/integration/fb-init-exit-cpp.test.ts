// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * FB_Init / FB_Exit / FB_Reinit (CODESYS online help, "Method: FB_Init,
 * FB_Reinit, FB_Exit"; IEC 61131-3 has no lifecycle methods):
 *
 * - FB_Init runs for every instance after its implicit initialization and
 *   before its initial assignments (`T1 : TON := (PT := t#500ms)` "executed
 *   only after calling FB_Init"); its inputs after bInitRetains / bInCopyCode
 *   are set at the declaration (`com1 : serialdevice(iCOMnum := 1)`).
 * - With EXTENDS each block's FB_Init runs, the base first; FB_Exit runs the
 *   derived block first ("Behavior for derived function blocks").
 * - FB_Reinit is not called by the system here (no online change); the
 *   application may call it.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import {
  compileWithGpp,
  createPCH,
  CXX_STD,
  cxxEnv,
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  runE2ETestPipeline,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
FUNCTION_BLOCK FB_Base
  VAR_INPUT x : INT := 3; END_VAR
  VAR_OUTPUT nInit : INT; END_VAR
  VAR n : INT := 7; pLog : POINTER TO INT; bRetains : BOOL; bCopy : BOOL := TRUE; END_VAR
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; nStart : INT := 11; END_VAR
    n := n * 100 + nStart;     (* the implicit initialization has run: n = 7 *)
    x := 1;                    (* the declaration's initial assignment comes after *)
    nInit := nInit + 1;
    bRetains := bInitRetains;
    bCopy := bInCopyCode;
  END_METHOD
  METHOD FB_Exit : BOOL
    VAR_INPUT bInCopyCode : BOOL; END_VAR
    IF pLog <> 0 THEN pLog^ := pLog^ * 10 + 1; END_IF
  END_METHOD
  METHOD PUBLIC FB_Reinit : BOOL
    n := 7;
  END_METHOD
  METHOD PUBLIC GetN : INT
    GetN := n;
  END_METHOD
  METHOD PUBLIC SetLog
    VAR_INPUT p : POINTER TO INT; END_VAR
    pLog := p;
  END_METHOD
  METHOD PUBLIC Flags : INT
    Flags := BOOL_TO_INT(bRetains) * 10 + BOOL_TO_INT(bCopy);
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Derived EXTENDS FB_Base
  VAR_OUTPUT m : INT := 2; END_VAR
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; nStart : INT; k : INT; END_VAR
    m := m * 10 + k + GetN();  (* the base's FB_Init has run *)
  END_METHOD
  METHOD FB_Exit : BOOL
    VAR_INPUT bInCopyCode : BOOL; END_VAR
    IF pLog <> 0 THEN pLog^ := pLog^ * 10 + 2; END_IF
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Plain EXTENDS FB_Base
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Owner
  VAR inner : FB_Derived(nStart := 2, k := 3) := (x := 8); END_VAR
  METHOD PUBLIC InnerM : INT
    InnerM := inner.m;
  END_METHOD
  METHOD PUBLIC InnerX : INT
    InnerX := inner.x;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION F_NewDelete : INT
  VAR p : POINTER TO FB_Derived; log : INT; END_VAR
  p := __NEW(FB_Derived);
  log := p^.GetN() / 100;       (* FB_Init ran with the defaults: 700 *)
  p^.SetLog(ADR(log));
  __DELETE(p);                  (* FB_Exit: the derived block, then the base *)
  F_NewDelete := log;
END_FUNCTION

FUNCTION F_Local : INT
  VAR f : FB_Derived(nStart := 4, k := 9); END_VAR
  F_Local := f.m;
END_FUNCTION

PROGRAM P
  VAR
    a : FB_Base(nStart := 5);
    d : FB_Derived(nStart := 1, k := 4) := (x := 9);
    e : FB_Derived;
    pl : FB_Plain(nStart := 6);
    o : FB_Owner;
  END_VAR
  a(); d();
END_PROGRAM
`;

describeIfGpp("FB_Init / FB_Exit (CODESYS)", () => {
  it("runs FB_Init with the declaration's arguments, the base first", () => {
    const test = `
TEST 'declaration arguments and order'
  VAR
    a : FB_Base(nStart := 5);
    d : FB_Derived(nStart := 1, k := 4) := (x := 9);
    e : FB_Derived;
    pl : FB_Plain(nStart := 6);
    b : FB_Base;
  END_VAR
  ASSERT_EQ(a.GetN(), 705);
  ASSERT_EQ(a.nInit, 1);
  ASSERT_EQ(a.x, 1);
  ASSERT_EQ(d.GetN(), 701);
  ASSERT_EQ(d.m, 725);
  ASSERT_EQ(d.x, 9);
  ASSERT_EQ(d.nInit, 1);
  ASSERT_EQ(e.GetN(), 700);
  ASSERT_EQ(e.m, 720);
  ASSERT_EQ(pl.GetN(), 706);
  ASSERT_EQ(b.GetN(), 711);
  ASSERT_EQ(b.Flags(), 10);
END_TEST

TEST 'nested instance, function local and FB_Reinit'
  VAR o : FB_Owner; b : FB_Base(nStart := 5); END_VAR
  ASSERT_EQ(o.InnerM(), 725);
  ASSERT_EQ(o.InnerX(), 8);
  ASSERT_EQ(F_Local(), 733);
  b.FB_Reinit();
  ASSERT_EQ(b.GetN(), 7);
END_TEST

TEST 'FB_Exit runs on __DELETE, the derived block first'
  ASSERT_EQ(F_NewDelete(), 721);
END_TEST
`;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SOURCE,
      testST: test,
      testFileName: "test_fb_init.st",
      tempDirPrefix: "strucpp-fb-init-",
    });
    expect(stdout).toContain("[PASS] declaration arguments and order");
    expect(stdout).toContain("[PASS] nested instance, function local and FB_Reinit");
    expect(stdout).toContain("[PASS] FB_Exit runs on __DELETE, the derived block first");
    expect(exitCode).toBe(0);
  });
});

describeIfGpp("FB_Init of a library block", () => {
  it("takes the declaration's arguments and runs FB_Exit", () => {
    const lib = compileStlib(
      [
        {
          fileName: "lifecycle.st",
          source: `
FUNCTION_BLOCK FB_LibBase
  VAR_OUTPUT n : INT := 7; END_VAR
  VAR pLog : POINTER TO INT; END_VAR
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; nStart : INT := 11; END_VAR
    n := n * 100 + nStart;
  END_METHOD
  METHOD FB_Exit : BOOL
    VAR_INPUT bInCopyCode : BOOL; END_VAR
    IF pLog <> 0 THEN pLog^ := pLog^ * 10 + 1; END_IF
  END_METHOD
  METHOD PUBLIC SetLog
    VAR_INPUT p : POINTER TO INT; END_VAR
    pLog := p;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_LibDerived EXTENDS FB_LibBase
  VAR_OUTPUT m : INT; END_VAR
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; nStart : INT; k : INT; END_VAR
    m := n + k;
  END_METHOD
END_FUNCTION_BLOCK
`,
        },
      ],
      { name: "lifecycle-lib", version: "1.0.0", namespace: "lifecycle" },
    );
    expect(lib.errors).toEqual([]);
    const archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    const derived = archive.manifest.functionBlocks.find(
      (f) => f.name === "FB_LIBDERIVED",
    );
    expect(derived?.fbInit?.inputs.map((i) => i.name)).toEqual([
      "BINITRETAINS",
      "BINCOPYCODE",
      "NSTART",
      "K",
    ]);
    expect(derived?.fbExit).toBe(true);
    const source = `
FUNCTION F_Exit : INT
  VAR p : POINTER TO FB_LibBase; log : INT := 4; END_VAR
  p := __NEW(FB_LibBase);
  p^.SetLog(ADR(log));
  __DELETE(p);
  F_Exit := log;
END_FUNCTION
FUNCTION F_Derived : INT
  VAR d : FB_LibDerived(nStart := 2, k := 1); END_VAR
  F_Derived := d.m;
END_FUNCTION
`;
    const test = `
TEST 'library FB_Init arguments'
  VAR a : FB_LibBase(nStart := 5); d : FB_LibDerived(nStart := 1, k := 3); END_VAR
  ASSERT_EQ(a.n, 705);
  ASSERT_EQ(d.n, 701);
  ASSERT_EQ(d.m, 704);
  ASSERT_EQ(F_Exit(), 41);
  ASSERT_EQ(F_Derived(), 703);
END_TEST
`;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: source,
      testST: test,
      testFileName: "test_fb_init_lib.st",
      tempDirPrefix: "strucpp-fb-init-lib-",
      compileOptions: { libraries: [archive] },
    });
    expect(stdout).toContain("[PASS] library FB_Init arguments");
    expect(exitCode).toBe(0);
  });

  it("refuses an argument the library block's FB_Init does not take", () => {
    const lib = compileStlib(
      [
        {
          fileName: "l.st",
          source: `
FUNCTION_BLOCK FB_L
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; a : INT; END_VAR
  END_METHOD
END_FUNCTION_BLOCK
`,
        },
      ],
      { name: "l-lib", version: "1.0.0", namespace: "llib" },
    );
    const result = compile(
      `PROGRAM P VAR f : FB_L(b := 1); END_VAR END_PROGRAM`,
      { libraries: [JSON.parse(JSON.stringify(lib.archive)) as StlibArchive] },
    );
    expect(result.errors.map((e) => e.message)).toEqual([
      "'F': 'B' is not an FB_Init input of 'FB_L' (A)",
    ]);
  });
});

describeIfGpp("FB_Init in a sealed block", () => {
  // A block with no base, no interface and nothing extending it binds its
  // methods statically (method-dead-strip-cpp.test.ts): FB_Init, FB_Exit and
  // an INTERNAL method are plain member functions, and an unused method is
  // still dropped by the linker.
  const SEALED = `
FUNCTION_BLOCK FB_Sealed
  VAR n : DINT; END_VAR
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; nStart : DINT; END_VAR
    n := nStart;
  END_METHOD
  METHOD FB_Exit : BOOL
    VAR_INPUT bInCopyCode : BOOL; END_VAR
    n := 0;
  END_METHOD
  METHOD INTERNAL Next : DINT
    n := n + 1;
    Next := n;
  END_METHOD
  METHOD PUBLIC NeverCalled : DINT
    n := n * 7 + 3;
    NeverCalled := n;
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
VAR c : FB_Sealed(nStart := 40); r : DINT; END_VAR
  r := c.Next();
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

  it("stays sealed: no virtual or override on its methods, unused ones dropped", () => {
    const result = compile(SEALED, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const methodLines = result.headerCode
      .split("\n")
      .filter((l) => /\b(FB_INIT|FB_EXIT|NEXT|NEVERCALLED)\(/.test(l));
    expect(methodLines.length).toBe(4);
    for (const line of methodLines) {
      expect(line).not.toMatch(/\bvirtual\b|\boverride\b/);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fb-init-sealed-"));
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
  p.run();
  std::printf(p.R == 42 ? "ALL_OK\\n" : "FAIL r=%d\\n", (int)p.R);
  return p.R == 42 ? 0 : 1;
}
`,
      );
      const bin = path.join(dir, "sealed");
      execSync(
        `g++ -std=${CXX_STD} -O1 -ffunction-sections -fdata-sections -Wl,--gc-sections ` +
          `-I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
          `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
      expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
      const symbols = execSync(`nm -C "${bin}"`, { encoding: "utf-8" });
      expect(symbols).toContain("FB_SEALED::FB_INIT");
      expect(symbols).not.toContain("FB_SEALED::NEVERCALLED");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeIfGpp("FB_Init in a configuration", () => {
  it("builds a configuration global, a program member and a temporary in place", () => {
    const result = compile(
      `
FUNCTION_BLOCK FB_Base
  VAR_INPUT x : INT := 3; END_VAR
  VAR n : INT := 7; END_VAR
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; nStart : INT := 11; END_VAR
    n := n * 100 + nStart;
  END_METHOD
  METHOD FB_Exit : BOOL
    VAR_INPUT bInCopyCode : BOOL; END_VAR
  END_METHOD
  n := n + x;
END_FUNCTION_BLOCK
PROGRAM P
  VAR a : FB_Base(nStart := 5); d : FB_Base := (x := 9); END_VAR
  VAR_TEMP t : FB_Base(nStart := 1); END_VAR
  a(); d(); t();
END_PROGRAM
CONFIGURATION C
  VAR_GLOBAL cg : FB_Base(nStart := 3) := (x := 5); END_VAR
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).toContain(
      "GlobalVar<FB_BASE> CG{strucpp::FbCtorArgs{}, strucpp::FbInitThen{}, [](auto& v0) { v0.X = 5; }, 3};",
    );
    expect(result.cppCode).toContain("    FB_BASE T{1};");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fb-init-cfg-"));
    try {
      const built = compileWithGpp({
        tempDir,
        pchPath: createPCH(tempDir),
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "fb_init_cfg",
      });
      expect(built.error ?? "").toBe("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("FB_Init / FB_Exit rules", () => {
  const errorsOf = (src: string): string[] =>
    compile(src).errors.map((e) => e.message);

  it("builds the program with instances declared with FB_Init arguments", () => {
    expect(errorsOf(SOURCE)).toEqual([]);
  });

  it("refuses a derived FB_Init that does not repeat the base's inputs", () => {
    const errors = errorsOf(`
FUNCTION_BLOCK B
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; a : INT; END_VAR
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; z : INT; END_VAR
  END_METHOD
END_FUNCTION_BLOCK
`);
    expect(errors).toEqual([
      "FB_Init of 'D' must declare the same inputs as the FB_Init of its base 'B' (BINITRETAINS, BINCOPYCODE, A), in that order, before any of its own",
    ]);
  });

  it("refuses wrong signatures", () => {
    const errors = errorsOf(`
FUNCTION_BLOCK B
  METHOD FB_Init : INT
    VAR_INPUT bInitRetains : BOOL; END_VAR
  END_METHOD
  METHOD FB_Exit : BOOL
    VAR_INPUT bInCopyCode : BOOL; extra : INT; END_VAR
  END_METHOD
  METHOD FB_Reinit : BOOL
    VAR_INPUT a : INT; END_VAR
  END_METHOD
END_FUNCTION_BLOCK
`);
    expect(errors).toEqual([
      `FB_Init of 'B' must return BOOL (CODESYS "Method: FB_Init, FB_Reinit, FB_Exit")`,
      "FB_Init of 'B' starts with the inputs bInitRetains : BOOL and bInCopyCode : BOOL",
      "FB_Exit of 'B' has exactly one input, bInCopyCode : BOOL",
      "FB_Reinit of 'B' takes no inputs",
    ]);
  });

  it("refuses SUPER^.FB_Init", () => {
    const errors = errorsOf(`
FUNCTION_BLOCK B
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
    SUPER^.FB_Init(bInitRetains := bInitRetains, bInCopyCode := bInCopyCode);
  END_METHOD
END_FUNCTION_BLOCK
`);
    expect(errors).toEqual([
      "SUPER^.FB_Init must not be called: the base's FB_Init has already run when this one runs",
    ]);
  });

  it("refuses bad declaration arguments", () => {
    const errors = errorsOf(`
FUNCTION_BLOCK B
  METHOD FB_Init : BOOL
    VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; a : INT; END_VAR
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK N
END_FUNCTION_BLOCK
PROGRAM P
  VAR
    b1 : B(z := 1);
    b2 : B(1);
    b3 : B(a := 1, a := 2);
    n1 : N(a := 1);
    i1 : INT(a := 1);
    arr : ARRAY[1..2] OF B := [(a := 1), (a := 2)];
  END_VAR
END_PROGRAM
`);
    expect(errors).toEqual([
      "'B1': 'Z' is not an FB_Init input of 'B' (A)",
      "'B2': FB_Init arguments are named, as in `B2 : B(A := value)`",
      "'B3': FB_Init input 'A' is set twice",
      "'N1': 'N' has no FB_Init input to set",
      "'I1': arguments after a type set the FB_Init inputs of a function block instance; 'INT' is not a function block",
      "'ARR': an initial value for an array of 'B' instances is not supported ('B' has FB_Init or FB_Exit); set the elements in the body",
    ]);
  });
});
