/**
 * A dereference (p^, r^) or a REFERENCE TO variable passed to a generic
 * (ANY) input: the descriptor addresses the variable pointed at, with its
 * class, size and name, and a callee writing through PVALUE writes it.
 *
 * The descriptor used to call raw_ptr() on what a POINTER TO points at (a
 * plain DINT or STRING) and on the REFERENCE TO wrapper itself, neither of
 * which has one, so the call did not compile.
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
TYPE Pair : STRUCT a : DINT; s : STRING(10); END_STRUCT; END_TYPE

FUNCTION Probe : DINT
  VAR_INPUT X : ANY; END_VAR
  {external
    extern void probe(const strucpp::IEC_ANY& any);
    probe(X);
    PROBE_result = 0;
  }
END_FUNCTION

PROGRAM Main
VAR
  n : DINT;
  dv : DINT := 41;
  sv : STRING(12) := 'text';
  pr : Pair := (a := 7, s := 'pair');
  p : POINTER TO DINT;
  ps : POINTER TO STRING(12);
  pp : POINTER TO Pair;
  rt : REF_TO DINT;
  rr : REFERENCE TO DINT;
  rs : REFERENCE TO STRING(12);
END_VAR
  p := ADR(dv);
  ps := ADR(sv);
  pp := ADR(pr);
  rt := REF(dv);
  rr REF= dv;
  rs REF= sv;
  n := Probe(X := p^);
  n := Probe(X := ps^);
  n := Probe(X := pp^);
  n := Probe(X := pp^.a);
  n := Probe(X := rt^);
  n := Probe(X := rr);
  n := Probe(X := rs);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const MAIN = `#include "generated.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
namespace strucpp {
// Logs what arrived and writes through PVALUE: a DINT is incremented, a
// STRING's first character upper-cased.
void probe(const IEC_ANY& a) {
  const char* cls = a.TYPECLASS == TYPE_CLASS::TYPE_DINT ? "DINT"
                  : a.TYPECLASS == TYPE_CLASS::TYPE_STRING ? "STRING"
                  : a.TYPECLASS == TYPE_CLASS::TYPE_USERDEF ? "USERDEF" : "?";
  printf("%s %s", a.NAME ? a.NAME : "-", cls);
  if (a.TYPECLASS != TYPE_CLASS::TYPE_USERDEF) printf(" %d", (int)a.DISIZE);
  printf(":");
  if (a.TYPECLASS == TYPE_CLASS::TYPE_DINT) {
    int32_t* v = reinterpret_cast<int32_t*>(a.PVALUE);
    printf(" %d", (int)*v);
    *v = *v + 1;
  } else if (a.TYPECLASS == TYPE_CLASS::TYPE_STRING) {
    char* t = reinterpret_cast<char*>(a.PVALUE);
    printf(" %s", t);
    if (t[0] >= 'a' && t[0] <= 'z') t[0] = (char)(t[0] - 32);
  } else if (a.TYPEDESC != nullptr) {
    printf(" %s", a.TYPEDESC->NAME);
  }
  printf("\\n");
}
}
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  printf("dv=%d sv=%s a=%d\\n", (int)p.DV, p.SV.get().c_str(), (int)p.PR.A);
  return 0;
}
`;

describeIfGpp("a dereference or a REFERENCE TO on a generic input", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-any-deref-"));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("addresses the variable pointed at, which the callee can write", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(path.join(tempDir, "main.cpp"), MAIN);
    const bin = path.join(tempDir, "deref");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    const out = execSync(`"${bin}"`, { encoding: "utf-8" });
    expect(out.trim().split("\n")).toEqual([
      `p^ DINT 4: 41`,
      `ps^ STRING 13: text`,
      "pp^ USERDEF: Pair",
      `pp^.a DINT 4: 7`,
      `rt^ DINT 4: 42`,
      `rr DINT 4: 43`,
      `rs STRING 13: Text`,
      "dv=44 sv=Text a=8",
    ]);
  });
});
