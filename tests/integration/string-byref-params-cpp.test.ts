/**
 * A STRING(n) or WSTRING(n) VAR_IN_OUT / VAR_OUTPUT of a function or method
 * keeps its declared length, and an actual of any length binds to it: the
 * callee writes within its own length, and an actual of another length gets
 * the result as an assignment would (truncated to the actual's length). The
 * parameter used to be a STRING(254) reference, which nothing but a
 * STRING(254) could bind.
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
FUNCTION Mark : INT
  VAR_IN_OUT IO : STRING(40); END_VAR
  VAR_OUTPUT S : STRING(4); END_VAR
  IO := CONCAT(IO, '!');
  S := 'abcdefg';
  Mark := LEN(S);
END_FUNCTION

FUNCTION Wide : INT
  VAR_IN_OUT X : WSTRING(10); END_VAR
  X := CONCAT(X, "z");
  Wide := LEN(X);
END_FUNCTION

FUNCTION_BLOCK Eng
  METHOD PUBLIC Rec : INT
    VAR_IN_OUT IO : STRING(40); END_VAR
    VAR_OUTPUT S : STRING(4); END_VAR
    IO := CONCAT(IO, '?');
    S := 'wxyz12';
    Rec := LEN(IO);
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
VAR_EXTERNAL G : STRING; END_VAR
VAR
  e : Eng;
  u : STRING(40) := 'same';
  t : STRING(4);
  w1 : STRING := 'long';
  w2 : STRING;
  two : STRING(2);
  pos1 : STRING(40) := 'p';
  pos2 : STRING(4);
  omit : STRING := 'o';
  mu : STRING(40) := 'm';
  mt : STRING(4);
  mw : STRING := 'mw';
  ws : WSTRING := "y";
  n1, n2, n3, n4, n5, n6, n7, n8, n9 : INT;
END_VAR
  n1 := Mark(IO := u, S => t);
  n2 := Mark(IO := w1, S => w2);
  n3 := Mark(IO := w1, S => two);
  n4 := Mark(pos1, pos2);
  n5 := Mark(IO := omit);
  n6 := e.Rec(IO := mu, S => mt);
  n7 := e.Rec(IO := mw);
  n8 := Mark(IO := G, S => w2);
  n9 := Wide(X := ws);
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL G : STRING := 'g'; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("a STRING(n) passed by reference", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strref-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("binds an actual of any length and keeps the callee within its own", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
static int fails = 0;
static void text(const char* what, const char* got, const char* want) {
  if (std::strcmp(got, want) != 0) {
    std::printf("FAIL %s: got '%s' want '%s'\\n", what, got, want);
    ++fails;
  }
}
static void num(const char* what, int got, int want) {
  if (got != want) {
    std::printf("FAIL %s: got %d want %d\\n", what, got, want);
    ++fails;
  }
}
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  text("u", p.U.c_str(), "same!");
  text("t", p.T.c_str(), "abcd");
  num("n1", p.N1, 4);
  // A STRING(254) actual: copied in and assigned back after the call.
  text("w1", p.W1.c_str(), "long!!");
  text("w2 from G call", p.W2.c_str(), "abcd");
  // A shorter actual takes what fits, as an assignment would.
  text("two", p.TWO.c_str(), "ab");
  text("pos1", p.POS1.c_str(), "p!");
  text("pos2", p.POS2.c_str(), "abcd");
  text("omit", p.OMIT.c_str(), "o!");
  num("n5", p.N5, 4);
  text("mu", p.MU.c_str(), "m?");
  text("mt", p.MT.c_str(), "wxyz");
  num("n6", p.N6, 2);
  text("mw", p.MW.c_str(), "mw?");
  num("n7", p.N7, 3);
  text("G", strucpp::G.read().c_str(), "g!");
  num("n9", p.N9, 2);
  std::printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return fails;
}
`,
    );
    const bin = path.join(tempDir, "strref");
    execSync(
      `g++ -std=${CXX_STD} -Wall -Werror=return-type -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
