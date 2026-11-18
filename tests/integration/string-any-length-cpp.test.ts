/**
 * STRING(n) / WSTRING(n) longer than 254 through the debug, retain and type
 * descriptor tables, compiled with g++ and run.
 *
 * S1  a 300-character STRING(320) reads correctly (126-character window,
 *     pointer, whole text);
 * S2  STRING(320) / WSTRING(300) force, hold, write and release;
 * S3  retain format 3 for strings over 254, and a program whose strings are
 *     all 254 or shorter writes blobs byte-identical to v0.8.0-modbee.4;
 * S4  format-1 and format-2 blobs written by v0.8.0-modbee.4 restore,
 *     including an old cap-0 value into STRING(n > 254);
 * S7  a STRUCT with a STRING(320) member has a type descriptor with CAP 320,
 *     and a v0.8.0-modbee.4 library's descriptor and debug table still read;
 * S8  strucpp_debug_read_text: the chunked read the runtimes serve as FC 0x4F.
 *
 * The v0.8.0-modbee.4 fixtures were built from that tag by
 * tests/fixtures/string-any-length/v0.8.0-modbee.4/gen-fixtures.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync, execSync } from "child_process";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const describeIfGpp = hasGpp ? describe : describe.skip;
const FIXTURES = path.resolve(
  __dirname,
  "../fixtures/string-any-length/v0.8.0-modbee.4",
);

const CFG = `
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

/** Character i of the test pattern. */
const pat = (n: number, base = 65) =>
  Array.from({ length: n }, (_, i) =>
    String.fromCharCode(base + (i % 26)),
  ).join("");
const PAT_CPP = `static char pat(int i) { return (char)('A' + i % 26); }`;

const PRELUDE = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include "iec_retain.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp;
using namespace strucpp::debug;
static int fails = 0;
static void expect_eq(const char* what, long got, long want) {
  if (got != want) { printf("FAIL %s: got %ld want %ld\\n", what, got, want); ++fails; }
}
${PAT_CPP}
`;

const RETAIN_HARNESS = `
static uint8_t wr(uint8_t a, uint16_t e, const uint8_t* b, uint16_t n) { return handle_write(a, e, b, n); }
static uint16_t sz(uint8_t a, uint16_t e) { return handle_size(a, e); }
static uint16_t rd(uint8_t a, uint16_t e, uint8_t* d) { return handle_read(a, e, d); }
static const retain::Host kHost = {
  &handle_retain_leaf, rd, wr, &handle_read_text, &handle_write_text, sz,
};
static std::vector<uint8_t> unhex(const char* s) {
  std::vector<uint8_t> out;
  for (size_t i = 0; s[i] && s[i + 1]; i += 2) {
    char b[3] = {s[i], s[i + 1], 0};
    out.push_back((uint8_t)strtoul(b, nullptr, 16));
  }
  return out;
}
int main(int argc, char** argv) {
  static uint8_t blob[65535];
  for (int i = 1; i < argc; ++i) {
    const char* cmd = argv[i];
    if (!strcmp(cmd, "set")) {
      FILE* f = fopen(argv[++i], "r");
      unsigned a, e; char kind[8]; static char hex[140000];
      while (fscanf(f, "%u %u %7s %139999s", &a, &e, kind, hex) == 4) {
        std::vector<uint8_t> v = unhex(strcmp(hex, "-") ? hex : "");
        uint8_t st = kind[0] == 't'
          ? handle_write_text((uint8_t)a, (uint16_t)e, v.data(), (uint16_t)v.size())
          : handle_write((uint8_t)a, (uint16_t)e, v.data(), (uint16_t)v.size());
        if (st != 0x7E) { printf("SETFAIL %u %u %02x\\n", a, e, st); return 2; }
      }
      fclose(f);
    } else if (!strcmp(cmd, "save2") || !strcmp(cmd, "save1")) {
      size_t n = !strcmp(cmd, "save2") ? retain::pack2(blob, sizeof blob, kHost)
                                       : retain::pack(blob, sizeof blob, rd, sz);
      if (!strcmp(cmd, "save2") && n != retain::blob_size2(kHost)) { printf("SIZEMISMATCH\\n"); return 3; }
      FILE* f = fopen(argv[++i], "wb"); fwrite(blob, 1, n, f); fclose(f);
      printf("SAVED %zu\\n", n);
    } else if (!strcmp(cmd, "step")) {        // step <budget> <file>: incremental pack
      unsigned budget = (unsigned)atoi(argv[++i]);
      uint32_t pay = 0, trl = 0;
      retain::layout2(kHost, &pay, &trl);
      retain::Packer2 pk;
      if (!retain::pack2_begin(pk, blob, sizeof blob, pay, trl)) { printf("BEGINFAIL\\n"); return 4; }
      while (pk.phase != retain::Packer2::Done && pk.phase != retain::Packer2::Failed)
        retain::pack2_step(pk, kHost, (uint16_t)budget);
      FILE* f = fopen(argv[++i], "wb"); fwrite(blob, 1, pk.size(), f); fclose(f);
      printf("STEPPED %zu\\n", pk.size());
    } else if (!strcmp(cmd, "load")) {
      FILE* f = fopen(argv[++i], "rb"); size_t n = fread(blob, 1, sizeof blob, f); fclose(f);
      retain::Report r;
      uint8_t res = (uint8_t)retain::unpack2(blob, n, kHost, &r);
      printf("REPORT %u %u %u %u %u %u %u %u\\n", res, r.format, r.kept, r.converted,
             r.truncated, r.added, r.dropped, r.refused);
    } else if (!strcmp(cmd, "dump")) {
      for (uint16_t k = 0; k < retain_var_count; ++k) {
        RetainLeafInfo l; handle_retain_leaf(k, &l);
        static uint8_t buf[140000]; uint16_t n;
        if (l.tag == TAG_STRING || l.tag == TAG_WSTRING) n = handle_read_text(l.arr, l.elem, buf, 65535);
        else n = handle_read(l.arr, l.elem, buf);
        printf("LEAF %u %u %u %u ", l.arr, l.elem, l.tag, l.cap);
        for (uint16_t b = 0; b < n; ++b) printf("%02x", buf[b]);
        printf(n ? "\\n" : "-\\n");
      }
    }
  }
  return 0;
}
`;

type Built = {
  bin: string;
  map: {
    leaves: Array<{
      path: string;
      arrayIdx: number;
      elemIdx: number;
      type: string;
    }>;
  };
};

describeIfGpp("STRING / WSTRING longer than 254 (g++)", () => {
  let tempDir = "";

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strlen-"));
  });
  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Write generated files and a main, compile with g++, return the binary. */
  function link(
    name: string,
    files: Record<string, string>,
    extraFlags = "",
  ): string {
    const dir = path.join(tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files))
      fs.writeFileSync(path.join(dir, f), text);
    const bin = path.join(dir, "prog");
    const sources = Object.keys(files)
      .filter((f) => f.endsWith(".cpp"))
      .map((f) => `"${path.join(dir, f)}"`)
      .join(" ");
    execSync(
      `g++ -std=${CXX_STD} -O0 ${extraFlags} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ${sources}`,
      { encoding: "utf-8", stdio: "pipe", env: cxxEnv },
    );
    return bin;
  }

  function build(
    name: string,
    source: string,
    main: string,
    libraries?: StlibArchive[],
  ): Built {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      ...(libraries ? { libraries } : {}),
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const bin = link(name, {
      "generated.hpp": result.headerCode,
      "generated.cpp": result.cppCode,
      "generated_debug.cpp": result.debugTableCpp!,
      "main.cpp": main,
    });
    return { bin, map: result.debugMap! as Built["map"] };
  }

  const idx = (b: Built, p: string): string => {
    const l = b.map.leaves.find((x) => x.path === p);
    if (!l) throw new Error(`no leaf ${p}`);
    return `${l.arrayIdx}, ${l.elemIdx}`;
  };

  /** Run a driver whose main body is generated from the built program's map. */
  function driver(
    name: string,
    source: string,
    body: (b: Built) => string,
    flags = "",
  ): string {
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const b: Built = { bin: "", map: result.debugMap! as Built["map"] };
    const bin = link(name, {
      "generated.hpp": result.headerCode,
      "generated.cpp": result.cppCode,
      "generated_debug.cpp": result.debugTableCpp!,
      "main.cpp": `${flags}${PRELUDE}\nint main() {\n${body(b)}\n  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);\n  return 0;\n}\n`,
    });
    return execFileSync(bin, [], { encoding: "utf-8" }).trim();
  }

  // Values by debug path, as "arr elem kind hex" lines for the retain harness.
  function valuesFile(
    b: Built,
    vals: Record<string, [string, string]>,
    file: string,
  ): string {
    const lines = Object.entries(vals).map(([p, [kind, hex]]) => {
      const l = b.map.leaves.find((x) => x.path === p);
      if (!l) throw new Error(`no leaf ${p}`);
      return `${l.arrayIdx} ${l.elemIdx} ${kind} ${hex}`;
    });
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  /** Retained values by path after `load`, as hex. */
  function dump(
    b: Built,
    out: string,
  ): Record<string, { tag: number; cap: number; hex: string }> {
    const byAddr = new Map(
      b.map.leaves.map((l) => [`${l.arrayIdx} ${l.elemIdx}`, l.path]),
    );
    const values: Record<string, { tag: number; cap: number; hex: string }> =
      {};
    for (const line of out.split("\n")) {
      const m = /^LEAF (\d+) (\d+) (\d+) (\d+) (\S+)$/.exec(line);
      if (m)
        values[byAddr.get(`${m[1]} ${m[2]}`)!] = {
          tag: +m[3]!,
          cap: +m[4]!,
          hex: m[5] === "-" ? "" : m[5]!,
        };
    }
    return values;
  }

  const report = (out: string) => {
    const m = /REPORT (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)/.exec(
      out,
    )!;
    const [
      result,
      format,
      kept,
      converted,
      truncated,
      added,
      dropped,
      refused,
    ] = m.slice(1).map(Number);
    return {
      result,
      format,
      kept,
      converted,
      truncated,
      added,
      dropped,
      refused,
    };
  };
  const OK = 0;
  const MIGRATED = 7;
  const hex = (s: string) => Buffer.from(s, "latin1").toString("hex");
  const whex = (s: string) => Buffer.from(s, "utf16le").toString("hex");

  // ---------------------------------------------------------------------------
  const LONG_PROGRAM = `PROGRAM Main
VAR
  s : STRING(320) := '${pat(300)}';
  w : WSTRING(300) := "${pat(280)}";
  n : DINT;
END_VAR
  n := n + 1;
END_PROGRAM${CFG}`;

  it("S1: reads a 300-character STRING(320) and a 280-unit WSTRING(300)", () => {
    const out = driver(
      "s1",
      LONG_PROGRAM,
      (b) => `
  static uint8_t buf[1024];
  uint16_t n = handle_read(${idx(b, "INSTANCE0.S")}, buf);
  expect_eq("string width", n, DEBUG_STRING_WIDTH);
  expect_eq("string window length", buf[0], 126);
  for (int i = 0; i < 126; ++i) if (buf[1 + i] != pat(i)) { expect_eq("string window char", i, -1); break; }
  uint32_t len = 0;
  const char* p = (const char*)handle_ptr(${idx(b, "INSTANCE0.S")}, &len);
  expect_eq("string ptr length", len, 300);
  for (int i = 0; p && i < 300; ++i) if (p[i] != pat(i)) { expect_eq("string ptr char", i, -1); break; }
  expect_eq("string text", handle_read_text(${idx(b, "INSTANCE0.S")}, buf, sizeof buf), 300);
  for (int i = 0; i < 300; ++i) if (buf[i] != pat(i)) { expect_eq("string text char", i, -1); break; }

  n = handle_read(${idx(b, "INSTANCE0.W")}, buf);
  expect_eq("wstring width", n, DEBUG_WSTRING_WIDTH);
  expect_eq("wstring window length", buf[0], 126);
  for (int i = 0; i < 126; ++i)
    if (buf[1 + 2 * i] != pat(i) || buf[2 + 2 * i] != 0) { expect_eq("wstring window unit", i, -1); break; }
  const char16_t* q = (const char16_t*)handle_ptr(${idx(b, "INSTANCE0.W")}, &len);
  expect_eq("wstring ptr bytes", len, 560);
  for (int i = 0; q && i < 280; ++i) if (q[i] != (char16_t)pat(i)) { expect_eq("wstring ptr unit", i, -1); break; }
  expect_eq("wstring text", handle_read_text(${idx(b, "INSTANCE0.W")}, buf, sizeof buf), 560);
  expect_eq("debug size", handle_size(${idx(b, "INSTANCE0.S")}), DEBUG_STRING_WIDTH);`,
    );
    expect(out).toBe("ALL_OK");
  });

  // ---------------------------------------------------------------------------
  const FORCE_PROGRAM = `PROGRAM Main
VAR
  s : STRING(320);
  w : WSTRING(300);
  cs : STRING(320);
  cw : WSTRING(300);
  guard : DINT := 12345;
END_VAR
  s := 'program';
  w := "program";
  cs := s;
  cw := w;
END_PROGRAM${CFG}`;

  it("S2: forces, holds, writes and releases STRING(320) and WSTRING(300)", () => {
    const out = driver("s2", FORCE_PROGRAM, (b) => {
      const S = idx(b, "INSTANCE0.S");
      const W = idx(b, "INSTANCE0.W");
      const CS = idx(b, "INSTANCE0.CS");
      const CW = idx(b, "INSTANCE0.CW");
      return `
  static uint8_t p[512], buf[1024];
  // STRING: 100 characters, the payload FC 0x42 carries.
  p[0] = 100; for (int i = 0; i < 100; ++i) p[1 + i] = (uint8_t)pat(i);
  expect_eq("force string", handle_set(${S}, true, p, 101), STATUS_OK);
  // WSTRING: 90 code units, little-endian.
  p[200] = 90; for (int i = 0; i < 90; ++i) { p[201 + 2 * i] = (uint8_t)pat(i); p[202 + 2 * i] = 0x04; }
  expect_eq("force wstring", handle_set(${W}, true, p + 200, 181), STATUS_OK);
  for (int scan = 0; scan < 3; ++scan) {
    g_config.INSTANCE0.run();
    expect_eq("forced string seen by the program", handle_read_text(${CS}, buf, sizeof buf), 100);
    for (int i = 0; i < 100; ++i) if (buf[i] != pat(i)) { expect_eq("forced string char", i, -1); break; }
    expect_eq("forced wstring seen by the program", handle_read_text(${CW}, buf, sizeof buf), 180);
    for (int i = 0; i < 90; ++i)
      if (buf[2 * i] != pat(i) || buf[2 * i + 1] != 0x04) { expect_eq("forced wstring unit", i, -1); break; }
  }
  expect_eq("string length", (long)g_config.INSTANCE0.S.get().length(), 100);
  handle_read(${S}, buf);
  expect_eq("read forced window", buf[0], 100);
  // A plain write leaves a force alone.
  expect_eq("write while forced", handle_write(${S}, (const uint8_t*)"\\x02xy", 3), STATUS_OK);
  expect_eq("still forced", (long)g_config.INSTANCE0.S.get().length(), 100);
  expect_eq("release string", handle_set(${S}, false, nullptr, 0), STATUS_OK);
  expect_eq("release wstring", handle_set(${W}, false, nullptr, 0), STATUS_OK);
  g_config.INSTANCE0.run();
  expect_eq("released string", handle_read_text(${CS}, buf, sizeof buf), 7);
  expect_eq("released wstring", handle_read_text(${CW}, buf, sizeof buf), 14);
  // Write: 126 characters, the FC 0x42 maximum, whole.
  p[0] = 126; for (int i = 0; i < 126; ++i) p[1 + i] = (uint8_t)pat(i + 3);
  expect_eq("write string", handle_write(${S}, p, 127), STATUS_OK);
  expect_eq("written length", (long)g_config.INSTANCE0.S.get().length(), 126);
  expect_eq("written last", (long)g_config.INSTANCE0.S.get().c_str()[125], pat(128));
  // Past the FC 0x42 window: refused, not cut.
  p[0] = 127;
  expect_eq("127 refused", handle_set(${S}, true, p, 128), STATUS_DATA_TOO_LARGE);
  expect_eq("guard", (long)g_config.INSTANCE0.GUARD.get(), 12345);`;
    });
    expect(out).toBe("ALL_OK");
  });

  // ---------------------------------------------------------------------------
  // The v0.8.0-modbee.4 fixture program (gen-fixtures.ts, SMALL).
  const SMALL = `TYPE
  CFG_T : STRUCT
    name : STRING(20) := 'pump';
    note : STRING;
    wide : WSTRING(12);
    full : STRING(254);
    count : DINT;
    flags : ARRAY[1..3] OF INT;
  END_STRUCT;
END_TYPE
PROGRAM Main
VAR RETAIN
  sl : STRING(30);
  s254 : STRING(254);
  w : WSTRING;
  hours : LINT;
END_VAR
  hours := hours;
END_PROGRAM
CONFIGURATION Config0
  VAR_GLOBAL RETAIN CFG : CFG_T; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;
  const SMALL_VALUES = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "small.values.json"), "utf-8"),
  ) as Record<string, [string, string]>;
  /** A SMALL value as stored: cut to its declared length, or to the window. */
  const SMALL_CAPS: Record<string, number> = { "INSTANCE0.SL": 30 };
  const expectedSmall = (p: string, window = 65535): string => {
    const [kind, h] = SMALL_VALUES[p]!;
    if (kind !== "t") return h;
    const unit = p === "CFG.WIDE" || p === "INSTANCE0.W" ? 4 : 2;
    return h.slice(0, Math.min(window, SMALL_CAPS[p] ?? 65535) * unit);
  };

  const LONG_RETAIN = `PROGRAM Main
VAR RETAIN
  s : STRING(320);
  w : WSTRING(300);
  short : STRING(10);
  n : DINT;
  a : ARRAY[1..3] OF INT;
END_VAR
  n := n;
END_PROGRAM${CFG}`;
  const LONG_VALUES: Record<string, [string, string]> = {
    "INSTANCE0.S": ["t", hex(pat(300))],
    "INSTANCE0.W": ["t", whex(pat(280) + "中")],
    "INSTANCE0.SHORT": ["t", hex("ten-chars!")],
    "INSTANCE0.N": ["s", "78563412"],
    "INSTANCE0.A[2]": ["s", "3412"],
  };

  it("S3: writes byte-identical v0.8.0-modbee.4 blobs when every string is 254 or shorter", () => {
    const b = build("s3-small", SMALL, PRELUDE + RETAIN_HARNESS);
    const vf = valuesFile(b, SMALL_VALUES, path.join(tempDir, "s3.values"));
    const v2 = path.join(tempDir, "s3.v2");
    const v1 = path.join(tempDir, "s3.v1");
    const st = path.join(tempDir, "s3.step");
    execFileSync(
      b.bin,
      ["set", vf, "save2", v2, "save1", v1, "step", "3", st],
      { encoding: "utf-8" },
    );
    expect(
      fs
        .readFileSync(v2)
        .equals(fs.readFileSync(path.join(FIXTURES, "small.v2.bin"))),
    ).toBe(true);
    expect(
      fs
        .readFileSync(v1)
        .equals(fs.readFileSync(path.join(FIXTURES, "small.v1.bin"))),
    ).toBe(true);
    expect(fs.readFileSync(st).equals(fs.readFileSync(v2))).toBe(true);
  });

  it("S3: writes format 3 for a retained string over 254 and restores it whole", () => {
    const b = build("s3-long", LONG_RETAIN, PRELUDE + RETAIN_HARNESS);
    const vf = valuesFile(b, LONG_VALUES, path.join(tempDir, "s3l.values"));
    const v3 = path.join(tempDir, "s3l.v3");
    const st = path.join(tempDir, "s3l.step");
    const saved = execFileSync(
      b.bin,
      ["set", vf, "save2", v3, "step", "2", st],
      { encoding: "utf-8" },
    );
    expect(saved).toContain("SAVED");
    const blob = fs.readFileSync(v3);
    expect(blob.readUInt16LE(0)).toBe(0x4f52);
    expect(blob[2]).toBe(3);
    // Payload: [u16 len][320], [u16 len][600], [u16 len][10], DINT, 3 INT.
    const payload = blob.readUInt16LE(8);
    expect(payload).toBe(322 + 602 + 12 + 4 + 6);
    expect(blob.readUInt16LE(14)).toBe(300);
    expect(blob.subarray(16, 316).toString("latin1")).toBe(pat(300));
    expect(blob.readUInt16LE(14 + 322)).toBe(281);
    // Trailer: 4 + four singles of 7 + one run of 13; caps are u16.
    const t = 14 + payload;
    expect(blob.readUInt16LE(t)).toBe(4 + 4 * 7 + 13);
    expect(blob.readUInt16LE(t + 2)).toBe(5);
    expect(blob[t + 4 + 4]).toBe(19); // TAG_STRING
    expect(blob.readUInt16LE(t + 4 + 5)).toBe(320);
    expect(blob.readUInt16LE(t + 4 + 7 + 5)).toBe(300);
    expect(blob.length).toBe(14 + payload + 4 + 4 * 7 + 13);
    expect(fs.readFileSync(st).equals(blob)).toBe(true);

    // Back into the same program: Ok, everything whole.
    const back = build("s3-long-back", LONG_RETAIN, PRELUDE + RETAIN_HARNESS);
    const out = execFileSync(back.bin, ["load", v3, "dump"], {
      encoding: "utf-8",
    });
    expect(report(out)).toMatchObject({
      result: OK,
      format: 3,
      kept: 7,
      refused: 0,
    });
    const vals = dump(back, out);
    expect(vals["INSTANCE0.S"]!.hex).toBe(hex(pat(300)));
    expect(vals["INSTANCE0.S"]!.cap).toBe(320);
    expect(vals["INSTANCE0.W"]!.hex).toBe(whex(pat(280) + "中"));
    expect(vals["INSTANCE0.SHORT"]!.hex).toBe(hex("ten-chars!"));

    // Into shorter strings: the leading characters are kept, and counted.
    const shorter = build(
      "s3-long-shorter",
      LONG_RETAIN.replace("STRING(320)", "STRING(100)").replace(
        "WSTRING(300)",
        "WSTRING(254)",
      ),
      PRELUDE + RETAIN_HARNESS,
    );
    const out2 = execFileSync(shorter.bin, ["load", v3, "dump"], {
      encoding: "utf-8",
    });
    expect(report(out2)).toMatchObject({
      result: MIGRATED,
      kept: 7,
      truncated: 2,
      refused: 0,
    });
    expect(dump(shorter, out2)["INSTANCE0.S"]!.hex).toBe(hex(pat(100)));
    expect(dump(shorter, out2)["INSTANCE0.W"]!.hex).toBe(whex(pat(254)));
  });

  it("S4: restores format-1 and format-2 blobs written by v0.8.0-modbee.4", () => {
    const b = build("s4-small", SMALL, PRELUDE + RETAIN_HARNESS);
    const out2 = execFileSync(
      b.bin,
      ["load", path.join(FIXTURES, "small.v2.bin"), "dump"],
      { encoding: "utf-8" },
    );
    expect(report(out2)).toMatchObject({
      result: OK,
      format: 2,
      refused: 0,
      added: 0,
      dropped: 0,
    });
    const v2 = dump(b, out2);
    for (const p of Object.keys(SMALL_VALUES))
      expect(v2[p]?.hex, p).toBe(expectedSmall(p));

    // Format 1 stored the 126-character debug window of each string.
    const out1 = execFileSync(
      b.bin,
      ["load", path.join(FIXTURES, "small.v1.bin"), "dump"],
      { encoding: "utf-8" },
    );
    expect(report(out1)).toMatchObject({ result: OK, format: 1, refused: 0 });
    const v1 = dump(b, out1);
    for (const p of Object.keys(SMALL_VALUES))
      expect(v1[p]?.hex, p).toBe(expectedSmall(p, 126));
  });

  it("S4: restores an old cap-0 value into STRING(n > 254)", () => {
    // v0.8.0-modbee.4 recorded both big (STRING(320)) and u (STRING) with cap 0.
    const b = build(
      "s4-large",
      `PROGRAM Main
VAR RETAIN
  big : STRING(320);
  u : STRING(300);
  n : DINT;
END_VAR
  n := n;
END_PROGRAM${CFG}`,
      PRELUDE + RETAIN_HARNESS,
    );
    const out = execFileSync(
      b.bin,
      ["load", path.join(FIXTURES, "large.v2.bin"), "dump"],
      { encoding: "utf-8" },
    );
    expect(report(out)).toMatchObject({
      result: MIGRATED,
      format: 2,
      kept: 3,
      refused: 0,
      added: 0,
      dropped: 0,
    });
    const vals = dump(b, out);
    expect(vals["INSTANCE0.U"]!.hex).toBe(hex("u-value-" + "U".repeat(200)));
    expect(vals["INSTANCE0.N"]!.hex).toBe("92100000");
    // The old build read big at the wrong offsets: whatever it saved is at
    // most 254 characters and lands inside the variable.
    expect(vals["INSTANCE0.BIG"]!.hex.length / 2).toBeLessThanOrEqual(254);
  });

  it("S5: named lengths build, and the retained ones match the C++ types", () => {
    const source = `VAR_GLOBAL CONSTANT GLEN : INT := 300; END_VAR
TYPE
  REC : STRUCT tag : STRING(GLEN); END_STRUCT;
END_TYPE
PROGRAM Main
VAR CONSTANT LLEN : INT := GLEN / 2 + 1; END_VAR
VAR RETAIN r : REC; l : STRING(LLEN); END_VAR
END_PROGRAM${CFG}`;
    const out = driver(
      "s5-named",
      source,
      (b) => `
  expect_eq("rec cap", string_cap<decltype(g_config.INSTANCE0.R.TAG)>::value, 300);
  expect_eq("local cap", string_cap<decltype(g_config.INSTANCE0.L)>::value, 151);
  static uint8_t buf[400];
  for (int i = 0; i < 400; ++i) buf[i] = (uint8_t)pat(i);
  expect_eq("write", handle_write_text(${idx(b, "INSTANCE0.R.TAG")}, buf, 400), STATUS_OK);
  strucpp_text_chunk info;
  strucpp_debug_read_text(${idx(b, "INSTANCE0.R.TAG")}, 0, 400, buf, sizeof buf, &info);
  expect_eq("len", info.len, 300);
  expect_eq("cap", info.cap, 300);`,
    );
    expect(out).toBe("ALL_OK");
  });

  // ---------------------------------------------------------------------------
  it("S7: describes a STRUCT with STRING(320) and WSTRING(1000) members", () => {
    const source = `TYPE
  REC : STRUCT
    a : STRING(320);
    b : WSTRING(1000);
    c : STRING(20);
    d : STRING;
  END_STRUCT;
END_TYPE
PROGRAM Main
VAR r : REC; END_VAR
END_PROGRAM${CFG}`;
    const out = driver(
      "s7",
      source,
      () => `
  const TypeDesc* d = &REC__TYPEDESC;
  expect_eq("members", d->MEMBERCOUNT, 4);
  expect_eq("a cap", d->MEMBERS[0].CAP, 320);
  expect_eq("b cap", d->MEMBERS[1].CAP, 1000);
  expect_eq("c cap", d->MEMBERS[2].CAP, 20);
  expect_eq("d cap", d->MEMBERS[3].CAP, 254);
  expect_eq("a class", d->MEMBERS[0].TYPECLASS, TYPE_STRING);
  expect_eq("b class", d->MEMBERS[1].TYPECLASS, TYPE_WSTRING);
  expect_eq("size", d->SIZE, sizeof(REC));
  // The width change of CAP moves nothing else.
  expect_eq("sizeof MemberDesc", sizeof(MemberDesc), sizeof(void*) == 8 ? 56 : 44);
  expect_eq("CAP offset", offsetof(MemberDesc, CAP), offsetof(MemberDesc, BASETYPECLASS) + sizeof(TYPE_CLASS));`,
    );
    expect(out).toBe("ALL_OK");
  });

  it("S7: a v0.8.0-modbee.4 library's type descriptor still reads", () => {
    const lib = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, "lib.stlib.json"), "utf-8"),
    ) as StlibArchive;
    const source = `PROGRAM Main
VAR x : S_LIB; END_VAR
END_PROGRAM${CFG}`;
    const result = compile(source, {
      headerFileName: "generated.hpp",
      libraries: [lib],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const bin = link("s7-lib", {
      "generated.hpp": result.headerCode,
      "generated.cpp": result.cppCode,
      "generated_debug.cpp": result.debugTableCpp!,
      "main.cpp": `${PRELUDE}
int main() {
  const TypeDesc* d = &S_LIB__TYPEDESC;
  expect_eq("members", d->MEMBERCOUNT, 4);
  expect_eq("tag cap", d->MEMBERS[0].CAP, 20);
  expect_eq("w cap", d->MEMBERS[1].CAP, 8);
  expect_eq("n cap", d->MEMBERS[2].CAP, 0);
  expect_eq("d cap", d->MEMBERS[3].CAP, 254);
  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return 0;
}
`,
    });
    expect(execFileSync(bin, [], { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });

  it("S7: a v0.8.0-modbee.4 debug table still reads, restores and packs", () => {
    const old = (f: string) =>
      fs.readFileSync(path.join(FIXTURES, "small", f), "utf-8");
    const bin = link("s7-old-table", {
      "generated.hpp": old("generated.hpp"),
      "generated.cpp": old("generated.cpp"),
      "generated_debug.cpp": old("generated_debug.cpp"),
      "main.cpp": PRELUDE + RETAIN_HARNESS,
    });
    const b: Built = { bin, map: JSON.parse(old("debug-map.json")) };
    const out = execFileSync(
      bin,
      ["load", path.join(FIXTURES, "small.v2.bin"), "dump"],
      { encoding: "utf-8" },
    );
    expect(report(out)).toMatchObject({
      result: OK,
      format: 2,
      refused: 0,
      added: 0,
      dropped: 0,
    });
    const vals = dump(b, out);
    for (const p of Object.keys(SMALL_VALUES))
      expect(vals[p]?.hex, p).toBe(expectedSmall(p));
    expect(vals["CFG.NAME"]!.cap).toBe(20);
    expect(vals["INSTANCE0.SL"]!.cap).toBe(30);
    // Its blob goes back into a program built by this compiler.
    const v2 = path.join(tempDir, "s7-old.v2");
    execFileSync(
      bin,
      ["load", path.join(FIXTURES, "small.v2.bin"), "save2", v2],
      { encoding: "utf-8" },
    );
    const fresh = build("s7-fresh", SMALL, PRELUDE + RETAIN_HARNESS);
    expect(
      report(execFileSync(fresh.bin, ["load", v2], { encoding: "utf-8" })),
    ).toMatchObject({ result: OK, refused: 0 });
  });

  // ---------------------------------------------------------------------------
  it("S8: strucpp_debug_read_text reads any part of a long string", () => {
    const out = driver(
      "s8",
      LONG_PROGRAM,
      (b) => {
        const S = idx(b, "INSTANCE0.S");
        const W = idx(b, "INSTANCE0.W");
        const N = idx(b, "INSTANCE0.N");
        return `
#ifndef STRUCPP_SHIM_HAS_DEBUG_TEXT
  expect_eq("STRUCPP_SHIM_HAS_DEBUG_TEXT", 0, 1);
#endif
  static uint8_t data[1024];
  strucpp_text_chunk info;
  // Whole STRING(320) in chunks of 128.
  std::vector<uint8_t> all;
  for (uint16_t off = 0; ; off = (uint16_t)(off + info.count)) {
    memset(&info, 0xEE, sizeof info);
    uint8_t st = strucpp_debug_read_text(${S}, off, 128, data, sizeof data, &info);
    expect_eq("status", st, 0x7E);
    expect_eq("status field", info.status, 0x7E);
    expect_eq("tag", info.tag, TAG_STRING);
    expect_eq("flags", info.flags, 0);
    expect_eq("cap", info.cap, 320);
    expect_eq("len", info.len, 300);
    if (info.count == 0) break;
    all.insert(all.end(), data, data + info.count);
  }
  expect_eq("assembled", (long)all.size(), 300);
  for (int i = 0; i < 300 && i < (int)all.size(); ++i) if (all[i] != (uint8_t)pat(i)) { expect_eq("char", i, -1); break; }
  // The tail, a short read, and past the end.
  strucpp_debug_read_text(${S}, 290, 100, data, sizeof data, &info);
  expect_eq("tail count", info.count, 10);
  expect_eq("tail char", data[0], pat(290));
  expect_eq("past end", strucpp_debug_read_text(${S}, 400, 10, data, sizeof data, &info), 0x7E);
  expect_eq("past end count", info.count, 0);
  // data_cap bounds the copy: nothing past it is written.
  memset(data, 0x5A, sizeof data);
  strucpp_debug_read_text(${S}, 0, 100, data, 50, &info);
  expect_eq("data_cap count", info.count, 50);
  expect_eq("data_cap guard", data[50], 0x5A);
  // WSTRING: little-endian code units, data_cap in bytes.
  memset(data, 0x5A, sizeof data);
  strucpp_debug_read_text(${W}, 10, 20, data, 39, &info);
  expect_eq("wstring tag", info.tag, TAG_WSTRING);
  expect_eq("wstring cap", info.cap, 300);
  expect_eq("wstring len", info.len, 280);
  expect_eq("wstring count", info.count, 19);
  expect_eq("wstring unit", data[0] | (data[1] << 8), pat(10));
  expect_eq("wstring guard", data[38], 0x5A);
  // Forced: flags bit 0.
  uint8_t p[3] = { 2, 'h', 'i' };
  handle_set(${S}, true, p, 3);
  strucpp_debug_read_text(${S}, 0, 10, data, sizeof data, &info);
  expect_eq("forced flag", info.flags & 1, 1);
  expect_eq("forced len", info.len, 2);
  // Not a string, or no such leaf.
  expect_eq("not a string", strucpp_debug_read_text(${N}, 0, 10, data, sizeof data, &info), 0x81);
  expect_eq("no such leaf", strucpp_debug_read_text(200, 0, 0, 10, data, sizeof data, &info), 0x81);`;
      },
      "#define STRUCPP_V4_DEBUG_EXPORTS_DEFINE\n",
    );
    expect(out).toBe("ALL_OK");
  });

  it("S8: strucpp_debug_write_text sets any length, and byte sizes over 65535 hold", () => {
    const source = `PROGRAM Main
VAR CONSTANT c : STRING(300) := 'fixed'; END_VAR
VAR s : STRING(320); big : WSTRING(40000); n : DINT; END_VAR
  n := n + 1;
END_PROGRAM${CFG}`;
    const out = driver("s8-write", source, (b) => {
      const S = idx(b, "INSTANCE0.S");
      const BIG = idx(b, "INSTANCE0.BIG");
      return `
  static uint8_t data[200000];
  strucpp_text_chunk info;
  for (int i = 0; i < 400; ++i) data[i] = (uint8_t)pat(i);
  expect_eq("write 300", strucpp_debug_write_text(${S}, data, 300), 0x7E);
  strucpp_debug_read_text(${S}, 0, 0, data + 1000, 10, &info);
  expect_eq("len 300", info.len, 300);
  expect_eq("write 400", strucpp_debug_write_text(${S}, data, 400), 0x7E);
  strucpp_debug_read_text(${S}, 319, 10, data + 1000, 10, &info);
  expect_eq("cut to 320", info.len, 320);
  expect_eq("last char", data[1000], pat(319));
  // A force holds: the write is a plain set.
  uint8_t f[3] = { 2, 'h', 'i' };
  handle_set(${S}, true, f, 3);
  expect_eq("write while forced", strucpp_debug_write_text(${S}, data, 10), 0x7E);
  strucpp_debug_read_text(${S}, 0, 10, data + 1000, 10, &info);
  expect_eq("still forced", info.len, 2);
  // WSTRING(40000): 35000 units, 70000 bytes.
  for (int i = 0; i < 35000; ++i) { data[2 * i] = (uint8_t)pat(i); data[2 * i + 1] = 0x01; }
  expect_eq("write wide", strucpp_debug_write_text(${BIG}, data, 35000), 0x7E);
  uint32_t len = 0;
  const char16_t* q = (const char16_t*)handle_ptr(${BIG}, &len);
  expect_eq("ptr bytes", len, 70000);
  expect_eq("ptr last unit", q ? q[34999] : 0, 0x0100 | (uint8_t)pat(34999));
  static uint8_t back[200000];
  expect_eq("read_text bytes", (long)handle_read_text(${BIG}, back, sizeof back), 70000);
  strucpp_debug_read_text(${BIG}, 34990, 100, data, 64, &info);
  expect_eq("tail count", info.count, 10);
  expect_eq("tail unit", data[0] | (data[1] << 8), 0x0100 | (uint8_t)pat(34990));
  // A CONSTANT reads with bit1 set; a writable string without it.
  strucpp_debug_read_text(${idx(b, "INSTANCE0.C")}, 0, 10, data, 10, &info);
  expect_eq("constant flag", info.flags, 2);
  expect_eq("constant text", info.len, 5);
  strucpp_debug_read_text(${BIG}, 0, 1, data, 10, &info);
  expect_eq("writable flag", info.flags & 2, 0);
  // Refusals.
  expect_eq("constant", strucpp_debug_write_text(${idx(b, "INSTANCE0.C")}, data, 3), STATUS_READ_ONLY);
  expect_eq("not a string", strucpp_debug_write_text(${idx(b, "INSTANCE0.N")}, data, 3), 0x81);
  expect_eq("no such leaf", strucpp_debug_write_text(200, 0, data, 3), 0x81);`;
    });
    expect(out).toBe("ALL_OK");
  });

  it("S8: exports strucpp_debug_read_text from a hidden-visibility shared object", () => {
    const result = compile(LONG_PROGRAM, { headerFileName: "generated.hpp" });
    const dir = path.join(tempDir, "s8-so");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(dir, "generated_debug.cpp"),
      result.debugTableCpp!,
    );
    fs.writeFileSync(
      path.join(dir, "entry.cpp"),
      `#define STRUCPP_V4_DEBUG_EXPORTS_DEFINE\n#include "generated.hpp"\n#include "debug_dispatch.hpp"\nstrucpp::Configuration_CONFIG0 g_config;\n`,
    );
    const so = path.join(dir, "libplc.so");
    execSync(
      `g++ -std=${CXX_STD} -shared -fPIC -fvisibility=hidden -fvisibility-inlines-hidden -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${so}" ` +
        ["entry.cpp", "generated.cpp", "generated_debug.cpp"]
          .map((f) => `"${path.join(dir, f)}"`)
          .join(" "),
      { encoding: "utf-8", stdio: "pipe", env: cxxEnv },
    );
    const syms = execSync(`nm -D --defined-only "${so}"`, {
      encoding: "utf-8",
    });
    expect(syms).toMatch(/ [TW] strucpp_debug_read_text$/m);
    expect(syms).toMatch(/ [TW] strucpp_debug_write_text$/m);
    expect(syms).toMatch(/ T strucpp_debug_read$/m);
  });
});
