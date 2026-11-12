/**
 * A literal or a computed value passed to a generic (ANY) parameter of a
 * method or a function.
 *
 * It has no storage, so the descriptor points into a temporary of its
 * declared type that lives for the call. The generated code used to call
 * `.raw_ptr()` on the literal itself (`"y=log".raw_ptr()`), which is not C++.
 * Each call below is run and what the callee received is checked, including
 * a loop condition that must build a fresh temporary every time it is tested.
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

FUNCTION_BLOCK Engine
  VAR_OUTPUT text : STRING; cls : DINT; size : DINT; END_VAR
  METHOD PUBLIC Record : DINT
    VAR_INPUT DATA : ANY; SETTINGS : ANY; END_VAR
    {external
      CLS = (int)SETTINGS.TYPECLASS;
      SIZE = SETTINGS.DISIZE;
      if (SETTINGS.TYPECLASS == strucpp::TYPE_CLASS::TYPE_STRING) {
        TEXT = reinterpret_cast<const char*>(SETTINGS.PVALUE);
      }
      RECORD_result = SETTINGS.TYPECLASS == strucpp::TYPE_CLASS::TYPE_DINT
        ? *reinterpret_cast<int32_t*>(SETTINGS.PVALUE)
        : SETTINGS.TYPECLASS == strucpp::TYPE_CLASS::TYPE_INT
          ? *reinterpret_cast<int16_t*>(SETTINGS.PVALUE)
          : SETTINGS.TYPECLASS == strucpp::TYPE_CLASS::TYPE_ENUM
            ? *reinterpret_cast<int16_t*>(SETTINGS.PVALUE)
            : -1;
    }
  END_METHOD
  METHOD PUBLIC Bump : DINT
    VAR_INPUT X : ANY; END_VAR
    {external
      int32_t* v = reinterpret_cast<int32_t*>(X.PVALUE);
      *v = *v + 1;
      BUMP_result = *v;
    }
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION AnySize : DINT
  VAR_INPUT X : ANY; END_VAR
  {external ANYSIZE_result = X.DISIZE; }
END_FUNCTION

PROGRAM Main
VAR
  e : Engine;
  p : DINT;
  k : INT := 3;
  r_str, r_dint, r_expr, r_enum, f_str, loops : DINT;
  t_str : STRING;
  c_str, c_dint, c_expr, c_enum : DINT;
END_VAR
  r_str := e.Record(DATA := p, SETTINGS := 'y=log');
  t_str := e.text; c_str := e.cls;
  r_dint := e.Record(DATA := p, SETTINGS := DINT#7);
  c_dint := e.cls;
  r_expr := e.Record(DATA := p, SETTINGS := k + 1);
  c_expr := e.cls;
  r_enum := e.Record(DATA := p, SETTINGS := RUN);
  c_enum := e.cls;
  f_str := AnySize(X := 'abcd');
  loops := 0;
  WHILE e.Bump(X := DINT#0) = 1 AND loops < 3 DO
    loops := loops + 1;
  END_WHILE;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const CHECKS = `
  check_s("t_str", p.T_STR, "y=log");
  check("c_str", p.C_STR, (int)strucpp::TYPE_CLASS::TYPE_STRING);
  check("r_dint", p.R_DINT, 7);
  check("c_dint", p.C_DINT, (int)strucpp::TYPE_CLASS::TYPE_DINT);
  check("r_expr", p.R_EXPR, 4);
  check("c_expr", p.C_EXPR, (int)strucpp::TYPE_CLASS::TYPE_INT);
  check("r_enum", p.R_ENUM, 1);
  check("c_enum", p.C_ENUM, (int)strucpp::TYPE_CLASS::TYPE_ENUM);
  // SIZEOF a STRING is its declared size, as for a STRING variable.
  check("f_str", p.F_STR, 255);
  check("loops", p.LOOPS, 3);
`;

describeIfGpp("a literal passed to a generic parameter of a call", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-any-lit-"));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("hands the callee a temporary of the literal's type", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).not.toMatch(/"y=log"\.raw_ptr\(\)/);
    expect(result.cppCode).toContain("strucpp::any_of_temporary(");
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
#include <string>
strucpp::Configuration_CONFIG0 g_config;
static int fails = 0;
static void check(const char* what, double got, double want) {
  if (got != want) { printf("FAIL %s: got %g want %g\\n", what, got, want); ++fails; }
}
template <typename S>
static void check_s(const char* what, const S& got, const char* want) {
  std::string g = got.get().c_str();
  if (g != want) { printf("FAIL %s: got '%s' want '%s'\\n", what, g.c_str(), want); ++fails; }
}
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
${CHECKS}
  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return fails ? 1 : 0;
}
`,
    );
    const bin = path.join(tempDir, "any-literals");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    let out = "";
    try {
      out = execSync(`"${bin}"`, { encoding: "utf-8" });
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? String(e);
    }
    expect(out.trim()).toBe("ALL_OK");
  });

  it("still refuses a literal on a function block's generic pin", () => {
    const pin = `
FUNCTION_BLOCK Holder
  VAR_INPUT CFG : ANY; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
  VAR h : Holder; END_VAR
  h(CFG := 'kept');
END_PROGRAM`;
    const result = compile(pin);
    expect(result.errors.map((e) => e.message)).toEqual([
      "Only a variable may be passed to the generic parameter 'CFG' of 'HOLDER' — " +
        "a literal, a constant or the result of an expression has no address to pass",
    ]);
  });
});
