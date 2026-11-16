/**
 * {attribute 'to_string'} on an enumeration (CODESYS, "Attribute: to_string"):
 * TO_STRING gives the member's declared name instead of its numeric value.
 * Without the attribute TO_STRING gives the number, as CODESYS does. Named
 * values (`Bad := 100`) are looked up by value. Only an opted-in enumeration
 * gets a name table; a struct member's descriptor and an ANY argument's point
 * at it (null otherwise), so C++ walking an ANY can print a member.
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
TYPE
  {attribute 'qualified_only'}
  {attribute 'strict'}
  {attribute 'to_string'}
  E_State : (Off, Idle, Running) := Off;
  {attribute 'to_string'}
  E_Err : UINT (None := 0, BadSetting := 100, LinkLost := 205) := None;
  E_Plain : (PlainA, PlainB) := PlainA;
  E_Num : UINT (NumX := 7, NumY := 9) := NumX;
  S_Rec : STRUCT
    eState : E_State;
    aStates : ARRAY[1..2] OF E_State;
    ePlain : E_Plain;
  END_STRUCT;
END_TYPE

FUNCTION F_Desc : DINT
  VAR_INPUT v : ANY; END_VAR
  {external
    const int16_t* raw = reinterpret_cast<const int16_t*>(V.PVALUE);
    const char* n = strucpp::enum_value_name(V.ENUMDESC, static_cast<int64_t>(raw[0]));
    F_DESC_result = (V.ENUMDESC == nullptr) ? -1 : (n != nullptr && std::strcmp(n, "LinkLost") == 0 ? 205 : (n != nullptr && std::strcmp(n, "Running") == 0 ? 2 : 0));
  }
END_FUNCTION

PROGRAM Main
VAR
  e : E_State := E_State.Running;
  f : E_Err := E_Err.LinkLost;
  g : E_Plain := E_Plain.PlainB;
  h : E_Num := E_Num.NumY;
  r : S_Rec;
  s1, s2, s3, s4, s5 : STRING;
  d1, d2, d3 : DINT;
END_VAR
  s1 := TO_STRING(e);
  s2 := TO_STRING(f);
  s3 := TO_STRING(g);
  s4 := TO_STRING(h);
  s5 := TO_STRING(E_State.Idle);
  d1 := F_Desc(v := e);
  d2 := F_Desc(v := f);
  d3 := F_Desc(v := g);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describeIfGpp("{attribute 'to_string'} on an enumeration", () => {
  let tempDir: string;
  let header = "";
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumstr-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("gives a name table only to an opted-in enumeration", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    header = result.headerCode;
    expect(header).toContain("iec_enum_names<E_STATE>");
    expect(header).toContain("iec_enum_names<E_ERR>");
    expect(header).not.toContain("iec_enum_names<E_PLAIN>");
    expect(header).not.toContain("iec_enum_names<E_NUM>");
    expect(header).toContain('"Running"');
    expect(header).toContain('"LinkLost"');
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
  });

  it("names a member, by value, and leaves the rest numeric", () => {
    expect(header).not.toBe("");
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
static int fails = 0;
static void eqs(const char* what, const char* got, const char* want) {
  if (std::strcmp(got, want) != 0) { std::printf("%s: got '%s' want '%s'\\n", what, got, want); ++fails; }
}
static void eq(const char* what, long got, long want) {
  if (got != want) { std::printf("%s: got %ld want %ld\\n", what, got, want); ++fails; }
}
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  eqs("to_string", p.S1.c_str(), "Running");
  eqs("named values, by value", p.S2.c_str(), "LinkLost");
  eqs("no attribute: the number", p.S3.c_str(), "1");
  eqs("typed, no attribute: the number", p.S4.c_str(), "9");
  eqs("a literal", p.S5.c_str(), "Idle");
  eq("ANY: the names of an opted-in enumeration", (long)p.D1, 2);
  eq("ANY: named values", (long)p.D2, 205);
  eq("ANY: no names without the attribute", (long)p.D3, -1);
  const strucpp::TypeDesc& t = strucpp::S_REC__TYPEDESC;
  eq("struct member: names", t.MEMBERS[0].ENUMDESC != nullptr, 1);
  eq("array of enumerations: the elements' names", t.MEMBERS[1].ENUMDESC != nullptr, 1);
  eq("struct member without the attribute: none", t.MEMBERS[2].ENUMDESC == nullptr, 1);
  eqs("the type's declared name", t.MEMBERS[0].ENUMDESC->NAME, "E_State");
  const char* unknown = strucpp::enum_value_name(t.MEMBERS[0].ENUMDESC, 42);
  eq("a value no member has", unknown == nullptr, 1);
  eqs("TO_STRING of a value no member has: the number",
      strucpp::iec_enum_to_string(static_cast<strucpp::E_ERR>(42)).c_str(), "42");
  std::printf(fails ? "FAIL\\n" : "ALL_OK\\n");
  return fails;
}
`,
    );
    const bin = path.join(tempDir, "enumstr");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
