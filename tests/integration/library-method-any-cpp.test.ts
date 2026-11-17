// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A method with an ANY input (CODESYS "Data Type: ANY"), declared in one
 * library and called from another library or a project: through an in-out
 * instance, an instance of a derived block (the library's or the caller's),
 * an interface and THIS^. A method's generic inputs were read from a map of
 * the unit's own blocks only, so such a call passed the variable bare and the
 * C++ did not build ("cannot convert IEC_INT to IEC_ANY"). They are now read
 * from the method's declaration wherever it came from.
 *
 * Also: a library block passed to a project block's VAR_IN_OUT from a TEST.
 * The test runner registered the libraries after the unit's own blocks, so
 * that in-out was not taken as a pointer and test_main.cpp did not build.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const libA = (noSource: boolean): StlibArchive => {
  const lib = compileStlib(
    [
      {
        fileName: "FB_Node.st",
        source: `
INTERFACE I_Watch
  METHOD Watch : BOOL
    VAR_INPUT anyData : ANY; nId : INT; END_VAR
    VAR_OUTPUT bSeen : BOOL; END_VAR
  END_METHOD
END_INTERFACE

FUNCTION_BLOCK FB_Node IMPLEMENTS I_Watch
  VAR_OUTPUT nLastSize : DINT; nCalls : INT; END_VAR
  METHOD PUBLIC Watch : BOOL
    VAR_INPUT anyData : ANY; nId : INT; END_VAR
    VAR_OUTPUT bSeen : BOOL; END_VAR
    nCalls := nCalls + 1;
    nLastSize := anyData.diSize;
    bSeen := anyData.diSize > 0;
    Watch := TRUE;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_NodeEx EXTENDS FB_Node
END_FUNCTION_BLOCK
`,
      },
    ],
    { name: "node-lib", version: "1.0.0", namespace: "nodelib", noSource },
  );
  expect(lib.errors).toEqual([]);
  return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
};

/** Every call of WATCH in `code` passes a descriptor for anyData. */
const expectDescriptors = (code: string, calls: number): void => {
  expect(code).not.toMatch(/(\.|->)WATCH\((?!strucpp::IEC_ANY\{)/);
  expect(code.match(/(\.|->)WATCH\(strucpp::IEC_ANY\{/g)?.length).toBe(calls);
};

const CALLER = `
FUNCTION_BLOCK FB_Dev
  VAR_IN_OUT fbNode : FB_Node; END_VAR
  VAR_OUTPUT nIntSize : DINT; nArrSize : DINT; bS : BOOL; END_VAR
  VAR nPh : INT; aPh : ARRAY[0..3] OF INT; bX : BOOL; END_VAR
  bX := fbNode.Watch(anyData := nPh, nId := 1, bSeen => bS);
  nIntSize := fbNode.nLastSize;
  bX := fbNode.Watch(anyData := aPh, nId := 2);
  nArrSize := fbNode.nLastSize;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_MyNode EXTENDS FB_Node
  METHOD PUBLIC Probe : BOOL
    VAR nL : LREAL; END_VAR
    Probe := THIS^.Watch(anyData := nL, nId := 5);
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Inherited
  VAR_OUTPUT nExSize : DINT; nMySize : DINT; nIfSize : DINT; nThisSize : DINT; END_VAR
  VAR
    ex : FB_NodeEx; my : FB_MyNode; n : FB_Node; itf : I_Watch;
    nD : DINT; bX : BOOL;
  END_VAR
  bX := ex.Watch(anyData := nD, nId := 1);
  nExSize := ex.nLastSize;
  bX := my.Watch(anyData := bX, nId := 2);
  nMySize := my.nLastSize;
  itf := n;
  bX := itf.Watch(anyData := nD, nId := 3);
  nIfSize := n.nLastSize;
  bX := my.Probe();
  nThisSize := my.nLastSize;
END_FUNCTION_BLOCK
`;
const CALLER_CALLS = 6;

describe("a library method's ANY input, called from another library", () => {
  for (const noSource of [false, true]) {
    it(`passes a descriptor (dependency ${noSource ? "without" : "with"} sources)`, () => {
      const b = compileStlib([{ fileName: "FB_Dev.st", source: CALLER }], {
        name: "dev-lib",
        version: "1.0.0",
        namespace: "devlib",
        dependencies: [libA(noSource)],
      });
      expect(b.errors).toEqual([]);
      const code = b.archive.chunks
        .map((c) => `${c.header}\n${c.cpp}`)
        .join("\n");
      expectDescriptors(code, CALLER_CALLS);
      expect(code).toContain(
        "WATCH(strucpp::IEC_ANY{ strucpp::TYPE_CLASS::TYPE_INT",
      );
      expect(code).toContain(
        "WATCH(strucpp::IEC_ANY{ strucpp::TYPE_CLASS::TYPE_ARRAY",
      );
    });
  }
});

describe("a library method's ANY input, called from a project", () => {
  for (const noSource of [false, true]) {
    it(`passes a descriptor (dependency ${noSource ? "without" : "with"} sources)`, () => {
      const result = compile(CALLER, { libraries: [libA(noSource)] });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      expectDescriptors(result.cppCode, CALLER_CALLS);
      // A library block in a project block's VAR_IN_OUT is bound by pointer.
      expect(result.cppCode).toContain("(*FBNODE).WATCH(strucpp::IEC_ANY{");
    });
  }

  it("passes a descriptor positionally and under a global's call lock", () => {
    const result = compile(
      `
VAR_GLOBAL gSeen : BOOL; END_VAR
PROGRAM Main
  VAR n : FB_Node; nPh : INT; bX : BOOL; END_VAR
  bX := n.Watch(anyData := nPh, nId := 1, bSeen => gSeen);
  bX := n.Watch(nPh, 2);
END_PROGRAM
`,
      { libraries: [libA(false)] },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expectDescriptors(result.cppCode, 2);
  });
});

describeIfGpp("a library method's ANY input, built and run", () => {
  for (const noSource of [false, true]) {
    it(`reaches the library method (dependency ${noSource ? "without" : "with"} sources)`, () => {
      const { stdout, exitCode } = runE2ETestPipeline({
        sourceST: CALLER,
        testST: `
TEST 'descriptors reach the library method'
  VAR n : FB_Node; d : FB_Dev; END_VAR
  d(fbNode := n);
  ASSERT_EQ(d.nIntSize, 2);
  ASSERT_EQ(d.nArrSize, 8);
  ASSERT_TRUE(d.bS);
  ASSERT_EQ(n.nCalls, 2);
END_TEST

TEST 'inherited and interface methods take a descriptor'
  VAR i : FB_Inherited; END_VAR
  i();
  ASSERT_EQ(i.nExSize, 4);
  ASSERT_EQ(i.nMySize, 1);
  ASSERT_EQ(i.nIfSize, 4);
  ASSERT_EQ(i.nThisSize, 8);
END_TEST
`,
        testFileName: "test_lib_method_any.st",
        tempDirPrefix: "strucpp-lib-method-any-",
        compileOptions: { libraries: [libA(noSource)] },
      });
      expect(stdout).toContain("[PASS] descriptors reach the library method");
      expect(stdout).toContain(
        "[PASS] inherited and interface methods take a descriptor",
      );
      expect(exitCode).toBe(0);
    });
  }
});
