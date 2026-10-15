/**
 * The PLC data block (`plcDataBlock`): the configuration's VAR_GLOBALs and the
 * configuration live in one `strucpp::PlcData` the runtime builds at start-up.
 *
 * The program is compiled, linked with a host stand-in for the runtime's
 * storage hook and run: it must build the block once, scan as it would with
 * file-scope storage, and every debugger path (read, write, force, in-out
 * leaves, retain pack/unpack), the global locks and the located globals must
 * reach the block. The debug tables must stay read-only data, not tables a
 * constructor fills in RAM.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, CXX_STD } from "./test-helpers.js";

const RUNTIME_INCLUDE = path.resolve(__dirname, "../../src/runtime/include");
const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
TYPE Pair : STRUCT a : INT; b : REAL; END_STRUCT; END_TYPE

FUNCTION_BLOCK Counter
VAR_EXTERNAL total : DINT; END_VAR
VAR_INPUT step : DINT; END_VAR
VAR count : DINT; END_VAR
  count := count + step;
  total := total + step;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Doubler
VAR_IN_OUT x : DINT; END_VAR
  x := x * 2;
END_FUNCTION_BLOCK

FUNCTION Bump : DINT
VAR_EXTERNAL total : DINT; END_VAR
VAR_INPUT n : DINT; END_VAR
  total := total + n;
  Bump := total;
END_FUNCTION

PROGRAM Main
VAR_EXTERNAL
  total : DINT; flag : BOOL; pr : Pair; arr : ARRAY[1..3] OF INT;
  lamp : BOOL; shared : Counter;
END_VAR
VAR c : Counter; d : Doubler; v : DINT := 3; r : DINT; END_VAR
VAR RETAIN kept : DINT := 7; END_VAR
  c(step := 2);
  d(x := v);
  r := Bump(n := 1);
  shared(step := 5);
  pr.a := pr.a + 1;
  arr[2] := arr[2] + 10;
  lamp := flag;
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL
    total : DINT := 100;
    flag : BOOL := TRUE;
    pr : Pair;
    arr : ARRAY[1..3] OF INT := [1, 2, 3];
    name : STRING(16) := 'pump';
    lamp AT %QX0.0 : BOOL;
    shared : Counter;
  END_VAR
  VAR_GLOBAL RETAIN setting : INT := 5; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

/** Host stand-ins for the runtime: block storage and platform locks. */
const HOOKS = `
#include <cstdlib>
#include <mutex>
static int g_allocs = 0;
extern "C" void* strucpp_platform_plc_data_alloc(size_t size) { ++g_allocs; return std::malloc(size); }
extern "C" void *strucpp_platform_mutex_create(void) { return new std::recursive_mutex(); }
extern "C" void strucpp_platform_mutex_lock(void *m) { static_cast<std::recursive_mutex *>(m)->lock(); }
extern "C" void strucpp_platform_mutex_unlock(void *m) { static_cast<std::recursive_mutex *>(m)->unlock(); }
extern "C" bool strucpp_platform_mutex_try_lock(void *m) { return static_cast<std::recursive_mutex *>(m)->try_lock(); }
extern "C" int64_t *strucpp_platform_current_time_slot(void) { static int64_t slot = 0; return &slot; }
`;

describeIfGpp("PLC data block", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-plcdata-"));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function build(): ReturnType<typeof compile> {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      plcDataBlock: true,
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.success).toBe(true);
    return result;
  }

  it("declares the block instead of file-scope globals", () => {
    const result = build();
    expect(result.headerCode).toContain("struct PlcData {");
    expect(result.headerCode).toContain(
      "    Configuration_CONFIG0 plc__config;",
    );
    expect(result.headerCode).toContain("    GlobalVar<IEC_DINT> TOTAL{100};");
    expect(result.headerCode).not.toMatch(/^extern GlobalVar</m);
    expect(result.cppCode).not.toMatch(/^GlobalVar</m);
    expect(result.cppCode).toContain(
      'extern "C" bool strucpp_plc_data_create(void)',
    );
    expect(result.debugTableCpp).toMatch(
      /using __dioT\d+ = ::strucpp::PlcData;/,
    );
    expect(result.debugTableCpp).not.toContain("g_config");
  });

  it("refuses a program with more than one configuration", () => {
    const two = `PROGRAM Solo
VAR n : INT; END_VAR
  n := n + 1;
END_PROGRAM
CONFIGURATION A
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM p WITH t : Solo;
  END_RESOURCE
END_CONFIGURATION
CONFIGURATION B
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM q WITH t : Solo;
  END_RESOURCE
END_CONFIGURATION`;
    const result = compile(two, { plcDataBlock: true });
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain(
      "exactly one CONFIGURATION",
    );
  });

  for (const opt of ["-O0", "-Os"]) {
    it(`builds, scans and debugs through the block (${opt})`, () => {
      const result = build();
      const dir = path.join(tempDir, `run${opt}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(dir, "generated_debug.cpp"),
        result.debugTableCpp!,
      );

      const idx = (p: string): string => {
        const leaf = result.debugMap!.leaves.find((l) => l.path === p);
        expect(leaf, `no leaf for ${p}`).toBeTruthy();
        return `${leaf!.arrayIdx}, ${leaf!.elemIdx}`;
      };
      const inout = result.debugMap!.leaves.find(
        (l) => l.path === "INSTANCE0.D.X",
      );

      fs.writeFileSync(
        path.join(dir, "main.cpp"),
        `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include "iec_retain.hpp"
#include <cstdio>
#include <cstring>
${HOOKS}
extern "C" uint32_t strucpp_global_count(void);
extern "C" bool strucpp_global_try_lock(uint32_t g);
extern "C" void strucpp_global_unlock(uint32_t g);
using namespace strucpp;
using namespace strucpp::debug;
static int fails = 0;
static void chk(const char* what, bool ok) { if (!ok) { printf("FAIL %s\\n", what); ++fails; } }
static int32_t rd32(uint8_t a, uint16_t e) { uint8_t b[8] = {0}; int32_t v = 0; if (handle_read(a, e, b) != 4) return -999; memcpy(&v, b, 4); return v; }
static uint16_t rd(uint8_t a, uint16_t e, uint8_t* d) { return handle_read(a, e, d); }
static uint8_t  wr(uint8_t a, uint16_t e, const uint8_t* b, uint16_t n) { return handle_write(a, e, b, n); }
static uint16_t sz(uint8_t a, uint16_t e) { return handle_size(a, e); }
static bool inside(const void* p) {
  const uint8_t* b = reinterpret_cast<const uint8_t*>(plc_data);
  const uint8_t* q = static_cast<const uint8_t*>(p);
  return q >= b && q < b + sizeof(PlcData);
}

int main() {
  // Before the block exists, every leaf reads as "no such variable".
  uint8_t buf[8];
  chk("no block yet", plc_data == nullptr);
  chk("read before create", handle_read(${idx("TOTAL")}, buf) == 0);
#ifdef STRUCPP_THREADED
  chk("lock before create", !strucpp_global_try_lock(0));
#endif

  chk("create", strucpp_plc_data_create());
  PlcData* first = plc_data;
  chk("create again", strucpp_plc_data_create() && plc_data == first && g_allocs == 1);

  // Declared initial values.
  chk("init total", (int)plc_data->TOTAL.value == 100);
  chk("init flag", (bool)plc_data->FLAG.value == true);
  chk("init arr", (int)plc_data->ARR.value[3] == 3);
  chk("init setting", (int)plc_data->SETTING.value == 5);
  chk("init local", (int)plc_data->plc__config.INSTANCE0.V == 3);

  // One scan: program, FB and function VAR_EXTERNALs and the FB-typed global
  // all reach the block's storage.
  plc_data->plc__config.INSTANCE0.run();
  chk("total after scan", (int)plc_data->TOTAL.value == 100 + 2 + 1 + 5);
  chk("bump result", (int)plc_data->plc__config.INSTANCE0.R == 103);
  chk("in-out doubled", (int)plc_data->plc__config.INSTANCE0.V == 6);
  chk("struct member", (int)plc_data->PR.value.A == 1);
  chk("array element", (int)plc_data->ARR.value[2] == 12);
  chk("lamp", (bool)plc_data->LAMP.value == true);

  // Debugger: every location lands inside the block.
  for (uint8_t a = 0; a < handle_array_count(); ++a)
    for (uint16_t e = 0; e < handle_elem_count(a); ++e) {
      Entry en = read_entry(a, e);
      if (en.ptr) chk("entry inside block", inside(en.ptr));
    }
  chk("debug read global", rd32(${idx("TOTAL")}) == 108);
  chk("debug read local", rd32(${idx("INSTANCE0.V")}) == 6);
  ${inout ? `chk("debug read in-out", rd32(${idx("INSTANCE0.D.X")}) == 6);` : ""}
  int32_t nv = 41;
  chk("debug write", handle_write(${idx("TOTAL")}, (const uint8_t*)&nv, 4) == STATUS_OK);
  chk("written", (int)plc_data->TOTAL.value == 41);
  int32_t fv = 77;
  chk("force", handle_set(${idx("INSTANCE0.R")}, true, (const uint8_t*)&fv, 4) == STATUS_OK);
  plc_data->plc__config.INSTANCE0.run();
  chk("forced holds", (int)plc_data->plc__config.INSTANCE0.R == 77);
  chk("unforce", handle_set(${idx("INSTANCE0.R")}, false, nullptr, 0) == STATUS_OK);

  // Retain: pack, lose the values, unpack.
  static uint8_t blob[4096];
  size_t n = retain::pack(blob, sizeof(blob), rd, sz);
  chk("packed", n > 0);
  plc_data->plc__config.INSTANCE0.KEPT = 0;
  plc_data->SETTING.value = 0;
  chk("unpack", retain::unpack(blob, n, wr, sz) == retain::LoadResult::Ok);
  chk("retained local", (int)plc_data->plc__config.INSTANCE0.KEPT == 7);
  chk("retained global", (int)plc_data->SETTING.value == 5);

#ifdef STRUCPP_THREADED
  // Locks by index reach the block's globals; located globals point into it.
  chk("global count", strucpp_global_count() > 0);
  for (uint32_t g = 0; g < strucpp_global_count(); ++g) {
    chk("lock", strucpp_global_try_lock(g));
    strucpp_global_unlock(g);
  }
  chk("located global", locatedGlobalsCount == 1 && inside(locatedGlobals[0]));
#endif
  chk("located var", inside(locatedVars[0].pointer));

  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return fails ? 1 : 0;
}
`,
      );

      for (const threads of [
        "",
        "-DSTRUCPP_THREADED -DSTRUCPP_PLATFORM_THREADS",
      ]) {
        const bin = path.join(dir, threads ? "run-threaded" : "run");
        const objs: string[] = [];
        for (const src of [
          "main.cpp",
          "generated.cpp",
          "generated_debug.cpp",
        ]) {
          const obj = path.join(dir, `${src}${threads ? ".t" : ""}.o`);
          execSync(
            `g++ -std=${CXX_STD} ${opt} -DSTRUCPP_PLC_DATA_BLOCK=1 ${threads} ` +
              `-I"${RUNTIME_INCLUDE}" -I"${dir}" -c "${path.join(dir, src)}" -o "${obj}" 2>&1`,
            { encoding: "utf-8" },
          );
          objs.push(obj);
        }
        // The tables stay constant data: no constructor fills them in RAM.
        const syms = execSync(`nm -C "${objs[2]}"`, { encoding: "utf-8" });
        const arr0 = syms
          .split("\n")
          .find((l) => / strucpp::debug::debug_arr_0$/.test(l));
        expect(arr0, "debug_arr_0 missing").toBeTruthy();
        expect(arr0!.split(" ")[1]!.toLowerCase()).toBe("r");
        const init = execSync(`objdump -dr -C "${objs[2]}"`, {
          encoding: "utf-8",
        });
        expect(init).not.toMatch(/R_\w+\s+strucpp::debug::debug_/);

        execSync(
          `g++ -o "${bin}" ${objs.map((o) => `"${o}"`).join(" ")} -lpthread 2>&1`,
          {
            encoding: "utf-8",
          },
        );
        expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe(
          "ALL_OK",
        );
      }
    });
  }

  it("is refused at build time without the define", () => {
    const result = build();
    const dir = path.join(tempDir, "nodefine");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(
      path.join(dir, "generated_debug.cpp"),
      result.debugTableCpp!,
    );
    let out = "";
    try {
      execSync(
        `g++ -std=${CXX_STD} -fsyntax-only -I"${RUNTIME_INCLUDE}" -I"${dir}" "${path.join(dir, "generated_debug.cpp")}" 2>&1`,
        { encoding: "utf-8" },
      );
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? e);
    }
    expect(out).toContain("-DSTRUCPP_PLC_DATA_BLOCK=1");
  });
});
