/**
 * The `$` combinations of a STRING / WSTRING literal (IEC 61131-3:2013 6.3.3,
 * Table 6 features 1g and 2h, Table 7) come out as exactly the characters the
 * standard names, in a statement, a variable initialiser and a STRUCT
 * element default, and on an ANY input.
 *
 * C++ reads a `\x` escape for as long as hex digits follow, so `$27c` written
 * as `"\x27c"` was one out-of-range character, not `'` and `c`.
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

/** [name, IEC literal, expected code units]. */
const NARROW: Array<[string, string, number[]]> = [
  ["dollar", "'a$$b'", [0x61, 0x24, 0x62]],
  ["quote", "'it$'s'", [0x69, 0x74, 0x27, 0x73]],
  ["doubled", "'it''s'", [0x69, 0x74, 0x27, 0x73]],
  ["ctl_upper", "'$L$N$P$R$T'", [0x0a, 0x0a, 0x0c, 0x0d, 0x09]],
  ["ctl_lower", "'$l$n$p$r$t'", [0x0a, 0x0a, 0x0c, 0x0d, 0x09]],
  ["hex_then_hexdigit", "'$27c'", [0x27, 0x63]],
  ["hex_then_hexdigits", "'$41BCd'", [0x41, 0x42, 0x43, 0x64]],
  ["hex_then_digit", "'$0A1'", [0x0a, 0x31]],
  ["hex_high", "'$FF$e9'", [0xff, 0xe9]],
  ["hex_twice", "'$41$42'", [0x41, 0x42]],
  ["cpp_specials", "'q\"x\\y'", [0x71, 0x22, 0x78, 0x5c, 0x79]],
];

const WIDE: Array<[string, string, number[]]> = [
  ["w_hex4", '"$00C4"', [0x00c4]],
  ["w_hex4_then_hexdigit", '"$00C4D"', [0x00c4, 0x44]],
  ["w_hex4_twice", '"$0041$0042f"', [0x41, 0x42, 0x66]],
  ["w_dollar_quote", '"a$$b$"c"', [0x61, 0x24, 0x62, 0x22, 0x63]],
  ["w_ctl", '"$N$T"', [0x0a, 0x09]],
];

const SOURCE = `
TYPE Holder : STRUCT d : STRING(8) := '$27c$41BCd'; END_STRUCT; END_TYPE

FUNCTION Units : DINT
  VAR_INPUT X : ANY; END_VAR
  {external
    extern void probe_units(const strucpp::IEC_ANY& any);
    probe_units(X);
    UNITS_result = 0;
  }
END_FUNCTION

PROGRAM Main
VAR
  n : DINT;
${NARROW.map(([name]) => `  ${name} : STRING(16);`).join("\n")}
${WIDE.map(([name]) => `  ${name} : WSTRING(16);`).join("\n")}
  init : STRING(8) := '$27c$41BCd';
  h : Holder;
END_VAR
${NARROW.map(([name, lit]) => `  ${name} := ${lit};`).join("\n")}
${WIDE.map(([name, lit]) => `  ${name} := ${lit};`).join("\n")}
  n := Units(X := '$27c$41BCd');
  n := Units(X := "$00C4D");
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const hex = (units: number[]): string =>
  units.map((u) => u.toString(16)).join(" ");

const MAIN = `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
template <typename S> static void show(const char* name, const S& s) {
  printf("%s:", name);
  for (const unsigned char* c = reinterpret_cast<const unsigned char*>(s.get().c_str()); *c; ++c) printf(" %x", *c);
  printf("\\n");
}
template <typename S> static void wshow(const char* name, const S& s) {
  printf("%s:", name);
  for (const char16_t* c = s.get().c_str(); *c; ++c) printf(" %x", (unsigned)*c);
  printf("\\n");
}
namespace strucpp {
void probe_units(const IEC_ANY& a) {
  printf("any %d:", (int)a.DISIZE);
  if (a.TYPECLASS == TYPE_CLASS::TYPE_STRING)
    for (const unsigned char* c = a.PVALUE; *c; ++c) printf(" %x", *c);
  else
    for (const char16_t* c = reinterpret_cast<const char16_t*>(a.PVALUE); *c; ++c) printf(" %x", (unsigned)*c);
  printf("\\n");
}
}
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
${NARROW.map(([name]) => `  show("${name}", p.${name.toUpperCase()});`).join("\n")}
${WIDE.map(([name]) => `  wshow("${name}", p.${name.toUpperCase()});`).join("\n")}
  show("init", p.INIT);
  show("struct", p.H.D);
  return 0;
}
`;

describeIfGpp("$ combinations in a string literal", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-escapes-"));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("gives the characters IEC 61131-3 Table 6 and Table 7 name", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(path.join(tempDir, "main.cpp"), MAIN);
    const bin = path.join(tempDir, "escapes");
    const warnings = execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" -o "${bin}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}" 2>&1`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(warnings).not.toContain("escape sequence out of range");
    const out = execSync(`"${bin}"`, { encoding: "utf-8" });
    const both = [0x27, 0x63, 0x41, 0x42, 0x43, 0x64];
    expect(out.trim().split("\n")).toEqual([
      `any 7: ${hex(both)}`,
      `any 6: ${hex([0x00c4, 0x44])}`,
      ...NARROW.map(([name, , units]) => `${name}: ${hex(units)}`),
      ...WIDE.map(([name, , units]) => `${name}: ${hex(units)}`),
      `init: ${hex(both)}`,
      `struct: ${hex(both)}`,
    ]);
  });
});
