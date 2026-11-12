/**
 * A method's VAR_OUTPUT is passed by pointer: NULL when the call omits it, so
 * the method binds a slot of its own and a call site builds no temporary
 * (CODESYS lets a call omit an output; IEC 61131-3 6.6.1.4.2 copies outputs
 * out after the call). Omitted, bound, partly bound, a STRING of another
 * length, a global, through an interface, an override and SUPER^, a bare own
 * method call, THIS^, and a C++ ({external}) body that writes an output by
 * its name and by its address.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
INTERFACE I_Serve
  METHOD Serve : DINT
    VAR_INPUT nId : DINT; END_VAR
    VAR_OUTPUT sText : STRING(64); nCount : DINT; END_VAR
  END_METHOD
END_INTERFACE

FUNCTION_BLOCK Node IMPLEMENTS I_Serve
  VAR nCalls : DINT; END_VAR
  METHOD PUBLIC Serve : DINT
    VAR_INPUT nId : DINT; END_VAR
    VAR_OUTPUT sText : STRING(64); nCount : DINT; END_VAR
    nCalls := nCalls + 1;
    sText := 'node';
    nCount := nCalls;
    Serve := nId * 10;
  END_METHOD
  METHOD PUBLIC Twice : DINT
    VAR_OUTPUT sLast : STRING(64); END_VAR
    VAR n : DINT; END_VAR
    n := Serve(nId := 1);
    n := THIS^.Serve(nId := 2, sText => sLast);
    Twice := n;
  END_METHOD
  METHOD PUBLIC Native : DINT
    VAR_OUTPUT nA : DINT; nB : DINT; END_VAR
    {external
      NA = 41;
      strucpp::IEC_DINT* p = &NB;
      *p = 42;
    }
    Native := nA + nB;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Child EXTENDS Node
  METHOD PUBLIC OVERRIDE Serve : DINT
    VAR_INPUT nId : DINT; END_VAR
    VAR_OUTPUT sText : STRING(64); nCount : DINT; END_VAR
    VAR s : STRING(64); END_VAR
    Serve := SUPER^.Serve(nId := nId, sText => s) + 1;
    sText := CONCAT('child ', s);
  END_METHOD
END_FUNCTION_BLOCK

VAR_GLOBAL
  gCount : DINT;
END_VAR

PROGRAM Main
VAR
  a : Node;
  c : Child;
  ip : I_Serve;
  r1, r2, r3, r4, r5, r6, r7, r8, r9 : DINT;
  n2, n3, n5 : DINT;
  s3 : STRING(64);
  sShort : STRING(4);
  sLong : STRING(80);
  s6, s7, s8 : STRING(64);
  nA, nB, rN : DINT;
END_VAR
  r1 := a.Serve(nId := 1);
  r2 := a.Serve(nId := 2, nCount => n2);
  r3 := a.Serve(nId := 3, sText => s3, nCount => n3);
  r4 := a.Serve(nId := 4, sText => sShort);
  r5 := a.Serve(nId := 5, sText => sLong, nCount => n5);
  r6 := a.Serve(nId := 6, nCount => gCount);
  ip := c;
  r7 := ip.Serve(nId := 7);
  r8 := ip.Serve(nId := 8, sText => s8);
  r9 := a.Twice(sLast => s6);
  nA := a.Native(nA => nA);
  rN := a.Native(nA => nA, nB => nB);
  a.Twice();
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("a method's outputs by pointer", () => {
  let tempDir: string;
  let generated = "";
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-mout-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("omits an output with NULL: no temporary at the call site", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    generated = result.cppCode;
    expect(result.cppCode).not.toContain("as_lvalue");
    expect(result.cppCode).toMatch(/A\.SERVE\(1, nullptr, nullptr\)/);
    expect(result.headerCode).toMatch(
      /SERVE\(IEC_DINT NID, IECStringVar<64>\* STEXT__out, IEC_DINT\* NCOUNT__out\)/,
    );
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
  });

  it("writes bound outputs, drops omitted ones, in every kind of call", () => {
    expect(generated).not.toBe("");
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
static int fails = 0;
static void eq(const char* what, long got, long want) {
  if (got != want) { std::printf("%s: got %ld want %ld\\n", what, got, want); ++fails; }
}
static void eqs(const char* what, const char* got, const char* want) {
  if (std::strcmp(got, want) != 0) { std::printf("%s: got '%s' want '%s'\\n", what, got, want); ++fails; }
}
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  eq("r1 omitted", (long)p.R1, 10);
  eq("r2 partly bound", (long)p.R2, 20); eq("n2", (long)p.N2, 2);
  eq("r3 bound", (long)p.R3, 30); eq("n3", (long)p.N3, 3); eqs("s3", p.S3.c_str(), "node");
  eq("r4", (long)p.R4, 40); eqs("a shorter string, truncated", p.SSHORT.c_str(), "node");
  eq("r5", (long)p.R5, 50); eqs("a longer string", p.SLONG.c_str(), "node"); eq("n5", (long)p.N5, 5);
  eq("r6", (long)p.R6, 60); eq("a global bound", (long)strucpp::GCOUNT, 6);
  eq("r7 interface, override, SUPER^, omitted", (long)p.R7, 71);
  eq("r8 interface, bound", (long)p.R8, 81); eqs("s8", p.S8.c_str(), "child node");
  eq("r9 bare and THIS^ calls", (long)p.R9, 20); eqs("s6", p.S6.c_str(), "node");
  eq("C++ body, nB omitted: the result", (long)p.RN, 83);
  eq("C++ body, bound by name", (long)p.NA, 41);
  eq("C++ body, bound by address", (long)p.NB, 42);
  std::printf(fails ? "FAIL\\n" : "ALL_OK\\n");
  return fails;
}
`,
    );
    const bin = path.join(tempDir, "mout");
    execSync(
      `g++ -std=${CXX_STD} -Wall -Werror=return-type -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
