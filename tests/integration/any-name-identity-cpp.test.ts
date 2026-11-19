/**
 * NAME of the IEC_ANY descriptor tells a callee whether a variable is behind
 * a generic argument. It is null for a literal, an enumeration value or an
 * expression (no variable), and the variable's name for every variable: a
 * structure member, an array element, a parenthesised variable, a
 * dereference, a REFERENCE TO, a global and an in-out.
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
TYPE Mode : (IDLE, RUN); END_TYPE
TYPE Pair : STRUCT a : DINT; s : STRING(10); END_STRUCT; END_TYPE

FUNCTION NameOf : DINT
  VAR_INPUT X : ANY; END_VAR
  {external
    extern void probe_name(const strucpp::IEC_ANY& any);
    probe_name(X);
    NAMEOF_result = 0;
  }
END_FUNCTION

FUNCTION Forward : DINT
  VAR_IN_OUT io : DINT; END_VAR
  Forward := NameOf(X := io);
END_FUNCTION

FUNCTION_BLOCK Probe
  METHOD PUBLIC Look : DINT
    VAR_INPUT X : ANY; END_VAR
    {external
      extern void probe_name(const strucpp::IEC_ANY& any);
      probe_name(X);
      LOOK_result = 0;
    }
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
VAR_EXTERNAL gv : DINT; END_VAR
VAR
  n, dv, i : DINT;
  k : INT := 3;
  sv : STRING := 'var';
  pr : Pair;
  arr : ARRAY[0..3] OF DINT;
  p : POINTER TO DINT;
  rr : REFERENCE TO DINT;
  m : Mode := RUN;
  pb : Probe;
END_VAR
  p := ADR(dv);
  rr REF= dv;
  i := 2;
  // No variable behind these: NAME is null.
  n := NameOf(X := 'lit');
  n := NameOf(X := "wide");
  n := NameOf(X := DINT#7);
  n := NameOf(X := k + 1);
  n := NameOf(X := RUN);
  n := pb.Look(X := 'lit');
  n := pb.Look(X := k * 2);
  // A variable: NAME names it.
  n := NameOf(X := sv);
  n := NameOf(X := pr.a);
  n := NameOf(X := pr.s);
  n := NameOf(X := arr[1]);
  n := NameOf(X := arr[i]);
  n := NameOf(X := p^);
  n := NameOf(X := rr);
  n := NameOf(X := (dv));
  n := NameOf(X := gv);
  n := NameOf(X := m);
  n := Forward(io := dv);
  n := pb.Look(X := sv);
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL gv : DINT; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const EXPECTED = [
  "-",
  "-",
  "-",
  "-",
  "-",
  "-",
  "-",
  "sv",
  "pr.a",
  "pr.s",
  "arr[1]",
  "arr[*]",
  "p^",
  "rr",
  "dv",
  "gv",
  "m",
  "io",
  "sv",
];

const MAIN = `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
namespace strucpp {
void probe_name(const IEC_ANY& a) { printf("%s\\n", a.NAME ? a.NAME : "-"); }
}
int main() { g_config.INSTANCE0.run(); return 0; }
`;

describeIfGpp("NAME of a generic argument", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-any-name-"));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("is null without a variable and names every variable", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(path.join(tempDir, "main.cpp"), MAIN);
    const bin = path.join(tempDir, "names");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    const out = execSync(`"${bin}"`, { encoding: "utf-8" });
    expect(out.trim().split("\n")).toEqual(EXPECTED);
  });
});
