/**
 * A STRING or WSTRING literal passed to a generic (ANY) input of a method or
 * a function: its descriptor addresses read-only storage made once, not a
 * temporary copy built at every call.
 *
 * IEC 61131-3:2013 6.4.3 leaves generic types in user POUs to the
 * implementer; 6.6.5.4.3 rule 9 and 6.6.2.3 make a method's inputs those of a
 * function call, and Figure 13 (6.6.3.4.2, row 2) forbids assigning an input
 * inside the POU. So the callee only reads the literal, and the literal (a
 * constant, 6.3.3) can be handed over where it already lives.
 *
 * Checked end to end with g++: the descriptor's fields, the text, the same
 * storage at every pass of a loop, forcing of a variable on the same pins,
 * and a block method shaped like a C/C++ block's (STRING, ANY and REFERENCE
 * pins).
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

const LONG = "x".repeat(300);

const SOURCE = `
FUNCTION_BLOCK Probe
  VAR_OUTPUT seen : DINT; END_VAR
  METHOD PUBLIC Look : DINT
    VAR_INPUT X : ANY; END_VAR
    {external
      extern void probe_log(const strucpp::IEC_ANY& any);
      probe_log(X);
      LOOK_result = X.DISIZE;
    }
  END_METHOD
  METHOD PUBLIC Take : DINT
    VAR_INPUT S : STRING(8); X : ANY; END_VAR
    {external
      extern void probe_text(const char* text);
      extern void probe_log(const strucpp::IEC_ANY& any);
      probe_text(S.c_str());
      probe_log(X);
      TAKE_result = (int32_t)S.length();
    }
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION AnyLook : DINT
  VAR_INPUT X : ANY; END_VAR
  {external
    extern void probe_log(const strucpp::IEC_ANY& any);
    probe_log(X);
    ANYLOOK_result = X.DISIZE;
  }
END_FUNCTION

PROGRAM Main
VAR
  pr : Probe;
  n, loops : DINT;
  sv : STRING := 'var';
  dv : DINT := 5;
END_VAR
  n := pr.Look(X := 'y=log');
  n := pr.Look(X := '');
  n := pr.Look(X := 'a$$b$27c''d$N');
  n := pr.Look(X := '${LONG}');
  n := pr.Look(X := "wide");
  n := pr.Look(X := DINT#7);
  n := pr.Look(X := sv);
  n := AnyLook(X := 'fn');
  loops := 0;
  WHILE pr.Look(X := 'abc') = 4 AND loops < 3 DO
    loops := loops + 1;
  END_WHILE;
  n := pr.Take(S := 'literal-long', X := 'lit');
  n := pr.Take(S := sv, X := sv);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

/** One line per descriptor or text the callee saw, in call order. */
const EXPECTED_LOG = [
  "cls=STRING size=6 count=1 elem=STRING desc=0 name=- type=STRING text=y=log",
  "cls=STRING size=2 count=1 elem=STRING desc=0 name=- type=STRING text=",
  // Escapes and doubled quotes count once each (the text is left out: see
  // the separate check of the escape below).
  "cls=STRING size=9 count=1 elem=STRING desc=0 name=- type=STRING",
  `cls=STRING size=301 count=1 elem=STRING desc=0 name=- type=STRING text=${LONG}`,
  "cls=WSTRING size=10 count=1 elem=WSTRING desc=0 name=- type=WSTRING text=wide",
  "cls=DINT size=4 count=1 elem=DINT desc=0 name=- type=DINT value=7",
  // A forced variable is seen at its forced value, through either pin.
  "cls=STRING size=255 count=1 elem=STRING desc=0 name=sv type=STRING text=forced-text",
  "cls=STRING size=3 count=1 elem=STRING desc=0 name=- type=STRING text=fn",
  "cls=STRING size=4 count=1 elem=STRING desc=0 name=- type=STRING text=abc",
  "cls=STRING size=4 count=1 elem=STRING desc=0 name=- type=STRING text=abc",
  "cls=STRING size=4 count=1 elem=STRING desc=0 name=- type=STRING text=abc",
  "cls=STRING size=4 count=1 elem=STRING desc=0 name=- type=STRING text=abc",
  // A STRING(8) input is the method's own copy, cut to its length.
  "text=literal-",
  "cls=STRING size=4 count=1 elem=STRING desc=0 name=- type=STRING text=lit",
  "text=forced-t",
  "cls=STRING size=255 count=1 elem=STRING desc=0 name=sv type=STRING text=forced-text",
];

const MAIN = `#include "generated.hpp"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
strucpp::Configuration_CONFIG0 g_config;
static std::vector<std::string> g_log;
static std::vector<const void*> g_abc;
namespace strucpp {
static const char* cls_name(TYPE_CLASS c) {
  switch (c) {
    case TYPE_CLASS::TYPE_STRING: return "STRING";
    case TYPE_CLASS::TYPE_WSTRING: return "WSTRING";
    case TYPE_CLASS::TYPE_DINT: return "DINT";
    default: return "?";
  }
}
void probe_text(const char* text) { g_log.push_back(std::string("text=") + text); }
void probe_log(const IEC_ANY& a) {
  std::string line = std::string("cls=") + cls_name(a.TYPECLASS) +
    " size=" + std::to_string(a.DISIZE) + " count=" + std::to_string(a.DICOUNT) +
    " elem=" + cls_name(a.ELEMCLASS) + " desc=" + (a.TYPEDESC ? "1" : "0") +
    " name=" + (a.NAME ? a.NAME : "-") + " type=" + (a.TYPENAME ? a.TYPENAME : "-");
  if (a.TYPECLASS == TYPE_CLASS::TYPE_STRING) {
    const char* t = reinterpret_cast<const char*>(a.PVALUE);
    if (std::strchr(t, '|') == nullptr && std::strchr(t, '\\'') == nullptr) line += std::string(" text=") + t;
    if (std::strcmp(t, "abc") == 0) g_abc.push_back(a.PVALUE);
  } else if (a.TYPECLASS == TYPE_CLASS::TYPE_WSTRING) {
    line += " text=";
    for (const char16_t* w = reinterpret_cast<const char16_t*>(a.PVALUE); *w; ++w) line += static_cast<char>(*w);
  } else if (a.TYPECLASS == TYPE_CLASS::TYPE_DINT) {
    line += " value=" + std::to_string(*reinterpret_cast<const int32_t*>(a.PVALUE));
  }
  g_log.push_back(line);
}
}  // namespace strucpp
int main() {
  auto& p = g_config.INSTANCE0;
  p.SV.force("forced-text");
  p.run();
  for (const auto& l : g_log) printf("%s\\n", l.c_str());
  printf("loops=%d abc_same=%d\\n", (int)p.LOOPS, (int)(g_abc.size() == 4 && g_abc[0] == g_abc[3]));
  return 0;
}
`;

function buildAndRun(dir: string, cppCode: string, headerCode: string): string {
  fs.writeFileSync(path.join(dir, "generated.hpp"), headerCode);
  fs.writeFileSync(path.join(dir, "generated.cpp"), cppCode);
  fs.writeFileSync(path.join(dir, "main.cpp"), MAIN);
  const bin = path.join(dir, "probe");
  execSync(
    `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
      `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}"`,
    { encoding: "utf-8", env: cxxEnv },
  );
  return execSync(`"${bin}"`, { encoding: "utf-8" });
}

describeIfGpp("a STRING literal on a generic input of a call", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-any-static-"));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("is described from read-only storage, not a temporary copy", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    // No per-call copy of a string literal, and no string type made per length.
    expect(result.cppCode).not.toMatch(/any_of_temporary\(IECW?StringVar</);
    expect(result.cppCode).not.toMatch(/IECW?StringVar<\d+>\("/);
    expect(result.cppCode).toContain(
      'static const uint8_t __anys[sizeof("y=log") > 6 ? sizeof("y=log") : 6] = "y=log";',
    );
    expect(result.cppCode).toContain(
      'static const char16_t __anys[sizeof(u"wide") / sizeof(char16_t) > 5 ? sizeof(u"wide") / sizeof(char16_t) : 5] = u"wide";',
    );
    // Any other literal keeps its temporary.
    expect(result.cppCode).toContain("strucpp::any_of_temporary(IEC_DINT(");
  });

  it("hands the callee the same descriptor, text and forcing as before", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const out = buildAndRun(tempDir, result.cppCode, result.headerCode);
    const lines = out.trim().split("\n");
    const tail = lines.pop();
    expect(lines).toEqual(EXPECTED_LOG);
    // The loop condition reads the same storage at every pass.
    expect(tail).toBe("loops=3 abc_same=1");
  });
});

/**
 * A function block written the way the editor writes a C/C++ block: each
 * METHOD fills a VARS struct and an ARGS struct and calls a C function in
 * another file. Called on a VAR_GLOBAL instance, so the call runs under the
 * global's lock in a threaded build.
 */
const BLOCK_SOURCE = `
FUNCTION_BLOCK Blk
  VAR_INPUT sTag : STRING(16) := 'tag'; END_VAR
  VAR nCalls : DINT; hasBeenInitialized : BOOL; END_VAR
  METHOD PUBLIC Put : INT
    VAR_INPUT sName : STRING(8); anyV : ANY; rTotal : REFERENCE TO DINT; END_VAR
    VAR_OUTPUT nLen : INT; END_VAR
    {external
    BLK_VARS vars;
    blk_bind_vars(&vars, this);
    BLK_PUT_ARGS args;
    args.SNAME = &SNAME;
    args.ANYV = &ANYV;
    args.RTOTAL = &RTOTAL;
    args.NLEN = &NLEN;
    }
    if hasBeenInitialized = False then
    {external
    blk_setup(&vars);
    }
    hasBeenInitialized := True;
    end_if;
    {external
    PUT_result = blk__put(&vars, &args);
    }
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
VAR_EXTERNAL G : Blk; END_VAR
VAR
  sv : STRING := 'var';
  t, u : DINT;
  l1, l2, r1, r2, r3 : INT;
END_VAR
  r1 := G.Put(sName := 'longer-name', anyV := 'literal-any', rTotal := t, nLen => l1);
  r2 := G.Put(sName := sv, anyV := sv, rTotal := t, nLen => l2);
  r3 := G.Put(sName := 'u', anyV := "w", rTotal := u);
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL G : Blk; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const C_BLOCKS_H = `#ifndef C_BLOCKS_H
#define C_BLOCKS_H
#include "generated.hpp"
#include <type_traits>
template <class Field, class Member>
inline void c_blocks_bind(Field *&field, Member &member, std::true_type) { field = member; }
template <class Field, class Member>
inline void c_blocks_bind(Field *&field, Member &member, std::false_type) { field = &member; }
template <class Field, class Member> inline void c_blocks_bind(Field *&field, Member &member) {
  c_blocks_bind(field, member, std::integral_constant<bool, std::is_convertible<Member &, Field *>::value>());
}
typedef struct {
  strucpp::IECStringVar<16> *STAG;
  strucpp::IEC_DINT *NCALLS;
} BLK_VARS;
extern "C" void blk_setup(BLK_VARS *vars);
typedef struct {
  strucpp::IECStringVar<8> *SNAME;
  strucpp::IEC_ANY *ANYV;
  strucpp::IEC_REFERENCE_TO<strucpp::DINT_t> *RTOTAL;
  strucpp::IEC_INT *NLEN;
} BLK_PUT_ARGS;
extern "C" strucpp::INT_t blk__put(BLK_VARS *vars, BLK_PUT_ARGS *args);
template <class Self> void blk_bind_vars(BLK_VARS *vars, Self *self) {
  c_blocks_bind(vars->STAG, self->STAG);
  c_blocks_bind(vars->NCALLS, self->NCALLS);
}
#endif
`;

const BLOCK_CODE = `#include "c_blocks.h"
#include <cstdio>
#include <string>
std::string g_block_log;
extern "C" void blk_setup(BLK_VARS *vars) { *vars->NCALLS = 100; }
extern "C" strucpp::INT_t blk__put(BLK_VARS *vars, BLK_PUT_ARGS *args) {
  auto& sName = *args->SNAME; auto& anyV = *args->ANYV; auto& rTotal = *args->RTOTAL; auto& nLen = *args->NLEN;
  std::string any;
  if (anyV.TYPECLASS == strucpp::TYPE_CLASS::TYPE_STRING) any = reinterpret_cast<const char*>(anyV.PVALUE);
  if (anyV.TYPECLASS == strucpp::TYPE_CLASS::TYPE_WSTRING)
    for (const char16_t* w = reinterpret_cast<const char16_t*>(anyV.PVALUE); *w; ++w) any += static_cast<char>(*w);
  char line[160];
  snprintf(line, sizeof line, "%s|%s|%s/%d|%d|%d\\n", vars->STAG->get().c_str(), sName.c_str(), any.c_str(),
           (int)anyV.DISIZE, (int)(int32_t)rTotal, (int)(int32_t)*vars->NCALLS);
  g_block_log += line;
  rTotal = (int32_t)rTotal + (int32_t)sName.length();
  *vars->NCALLS = (int32_t)*vars->NCALLS + 1;
  nLen = (int16_t)any.size();
  return (int16_t)sName.length();
}
`;

const BLOCK_MAIN = `#include "generated.hpp"
#include <cstdio>
#include <string>
extern std::string g_block_log;
strucpp::Configuration_CONFIG0 g_config;
int main() {
  auto& p = g_config.INSTANCE0;
  p.SV.force("forced-text");
  p.U.force(40);
  p.run();
  printf("%s", g_block_log.c_str());
  printf("t=%d u=%d l1=%d l2=%d r1=%d r2=%d r3=%d calls=%d\\n", (int)p.T, (int)p.U, (int)p.L1, (int)p.L2,
         (int)p.R1, (int)p.R2, (int)p.R3, (int)strucpp::G.value.NCALLS);
  return 0;
}
`;

describeIfGpp(
  "a C/C++ block method with STRING, ANY and REFERENCE pins",
  () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cblock-"));
    });

    afterAll(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it.each([
      ["unthreaded", ""],
      ["threaded", "-DSTRUCPP_THREADED"],
    ])(
      "reads each pin and writes through the reference (%s)",
      (_name, flags) => {
        const result = compile(BLOCK_SOURCE, {
          headerFileName: "generated.hpp",
          pouIncludes: ["c_blocks.h"],
        });
        expect(result.errors.map((e) => e.message)).toEqual([]);
        const dir = path.join(tempDir, _name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
        fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
        fs.writeFileSync(path.join(dir, "c_blocks.h"), C_BLOCKS_H);
        fs.writeFileSync(path.join(dir, "block.cpp"), BLOCK_CODE);
        fs.writeFileSync(path.join(dir, "main.cpp"), BLOCK_MAIN);
        const bin = path.join(dir, "block");
        const files = ["main.cpp", "generated.cpp", "block.cpp"]
          .map((f) => `"${path.join(dir, f)}"`)
          .join(" ");
        execSync(
          `g++ -std=${CXX_STD} ${flags} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ${files} -lpthread`,
          { encoding: "utf-8", env: cxxEnv },
        );
        const out = execSync(`"${bin}"`, { encoding: "utf-8" });
        expect(out.trim().split("\n")).toEqual([
          // STRING(8) input cut to its length; the literal on ANY whole.
          "tag|longer-n|literal-any/12|0|100",
          // A forced variable at its forced value through both pins.
          "tag|forced-t|forced-text/255|8|101",
          // A WSTRING literal; the reference reads its forced target.
          "tag|u|w/4|40|102",
          // The forced reference target keeps its forced value.
          "t=16 u=40 l1=11 l2=11 r1=8 r2=8 r3=1 calls=103",
        ]);
      },
    );
  },
);
