/**
 * A CONSTANT is never part of the retain image.
 *
 * IEC 61131-3:2013 Annex A (p. 224): a variable section takes CONSTANT,
 * RETAIN or NON_RETAIN as alternatives (Loc_Var_Decls, Global_Var_Decls), and
 * Figure 7 defines CONSTANT as "variable cannot be modified". A constant
 * inside a RETAIN block instance is therefore not retained: it is left out of
 * the walk and the image, so the restore it would always refuse never happens.
 *
 * The old image was written by v0.8.0-modbee.4, which did retain the
 * constants (tests/fixtures/string-any-length/v0.8.0-modbee.4/gen-fixtures.ts,
 * CONSTFB).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync, execSync } from "child_process";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

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

// The same program as gen-fixtures.ts CONSTFB.
const CONSTFB = `FUNCTION_BLOCK FB_C
VAR CONSTANT L : INT := 7; END_VAR
VAR n : DINT; s : STRING(10); END_VAR
  n := n + L;
END_FUNCTION_BLOCK
PROGRAM Main
VAR RETAIN c : FB_C; cs : ARRAY[1..2] OF FB_C; hours : LINT; END_VAR
  c();
END_PROGRAM${CFG}`;

const HARNESS = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include "iec_retain.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp;
using namespace strucpp::debug;
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
      unsigned a, e; char kind[8]; static char hex[4096];
      while (fscanf(f, "%u %u %7s %4095s", &a, &e, kind, hex) == 4) {
        std::vector<uint8_t> v = unhex(hex);
        uint8_t st = kind[0] == 't'
          ? handle_write_text((uint8_t)a, (uint16_t)e, v.data(), (uint16_t)v.size())
          : handle_write((uint8_t)a, (uint16_t)e, v.data(), (uint16_t)v.size());
        if (st != 0x7E) { printf("SETFAIL %u %u %02x\\n", a, e, st); return 2; }
      }
      fclose(f);
    } else if (!strcmp(cmd, "save")) {
      size_t n = retain::pack2(blob, sizeof blob, kHost);
      FILE* f = fopen(argv[++i], "wb"); fwrite(blob, 1, n, f); fclose(f);
      printf("SAVED %zu\\n", n);
    } else if (!strcmp(cmd, "load")) {
      FILE* f = fopen(argv[++i], "rb"); size_t n = fread(blob, 1, sizeof blob, f); fclose(f);
      retain::Report r;
      uint8_t res = (uint8_t)retain::unpack2(blob, n, kHost, &r);
      printf("REPORT %u %u %u %u %u %u\\n", res, r.kept, r.added, r.dropped, r.refused, r.converted);
    } else if (!strcmp(cmd, "dump")) {
      for (uint16_t k = 0; k < retain_var_count; ++k) {
        RetainLeafInfo l; handle_retain_leaf(k, &l);
        uint8_t buf[512]; uint16_t n;
        if (l.tag == TAG_STRING || l.tag == TAG_WSTRING) n = handle_read_text(l.arr, l.elem, buf, (uint16_t)sizeof buf);
        else n = handle_read(l.arr, l.elem, buf);
        printf("LEAF %u %u ", l.arr, l.elem);
        for (uint16_t b = 0; b < n; ++b) printf("%02x", buf[b]);
        printf(n ? "\\n" : "-\\n");
      }
    }
  }
  return 0;
}
`;

type Map2 = {
  leaves: Array<{ path: string; arrayIdx: number; elemIdx: number }>;
  retainVars?: Array<{ path: string }>;
};

describeIfGpp("CONSTANT members are not retained (g++)", () => {
  let tempDir = "";
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-retain-const-"));
  });
  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function build(name: string, source: string, libraries?: StlibArchive[]) {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      ...(libraries ? { libraries } : {}),
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const dir = path.join(tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(dir, "generated_debug.cpp"),
      result.debugTableCpp!,
    );
    fs.writeFileSync(path.join(dir, "main.cpp"), HARNESS);
    const bin = path.join(dir, "prog");
    execSync(
      `g++ -std=${CXX_STD} -O0 -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
        ["main.cpp", "generated.cpp", "generated_debug.cpp"]
          .map((f) => `"${path.join(dir, f)}"`)
          .join(" "),
      { encoding: "utf-8", stdio: "pipe", env: cxxEnv },
    );
    return { bin, map: result.debugMap! as unknown as Map2 };
  }

  const report = (out: string) => {
    const m = /REPORT (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)/.exec(out)!;
    const [result, kept, added, dropped, refused, converted] = m
      .slice(1)
      .map(Number);
    return { result, kept, added, dropped, refused, converted };
  };
  const dump = (map: Map2, out: string): Record<string, string> => {
    const byAddr = new Map(
      map.leaves.map((l) => [`${l.arrayIdx} ${l.elemIdx}`, l.path]),
    );
    const values: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const m = /^LEAF (\d+) (\d+) (\S+)$/.exec(line);
      if (m) values[byAddr.get(`${m[1]} ${m[2]}`)!] = m[3] === "-" ? "" : m[3]!;
    }
    return values;
  };
  const OK = 0;
  const MIGRATED = 7;
  const VALUES = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "constfb.values.json"), "utf-8"),
  ) as Record<string, [string, string]>;

  function setValues(b: { bin: string; map: Map2 }, file: string): string {
    const lines = Object.entries(VALUES).map(([p, [kind, h]]) => {
      const l = b.map.leaves.find((x) => x.path === p)!;
      return `${l.arrayIdx} ${l.elemIdx} ${kind} ${h}`;
    });
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  it("leaves a RETAIN block's CONSTANT out, and restores with result OK", () => {
    const b = build("constfb", CONSTFB);
    const retained = b.map.retainVars!.map((v) => v.path);
    expect(retained).toEqual([
      "INSTANCE0.C.N",
      "INSTANCE0.C.S",
      "INSTANCE0.CS[1].N",
      "INSTANCE0.CS[1].S",
      "INSTANCE0.CS[2].N",
      "INSTANCE0.CS[2].S",
      "INSTANCE0.HOURS",
    ]);
    // Still a debug leaf, read-only.
    expect(b.map.leaves.some((l) => l.path === "INSTANCE0.C.L")).toBe(true);
    const blob = path.join(tempDir, "new.v2");
    execFileSync(b.bin, ["set", setValues(b, blob + ".values"), "save", blob], {
      encoding: "utf-8",
    });
    const bytes = fs.readFileSync(blob);
    // Trailer: entry count = 7 retained leaves, none of them an INT (L).
    const payload = bytes.readUInt16LE(8);
    expect(bytes.readUInt16LE(14 + payload + 2)).toBe(7);
    const out = execFileSync(b.bin, ["load", blob, "dump"], {
      encoding: "utf-8",
    });
    expect(report(out)).toMatchObject({
      result: OK,
      kept: 7,
      refused: 0,
      dropped: 0,
      added: 0,
    });
    const vals = dump(b.map, out);
    for (const [p, [, h]] of Object.entries(VALUES)) expect(vals[p], p).toBe(h);
  });

  it("restores an old image that held the constants, and saves without them", () => {
    const b = build("constfb-old", CONSTFB);
    const out = execFileSync(
      b.bin,
      ["load", path.join(FIXTURES, "constfb.v2.bin"), "dump"],
      {
        encoding: "utf-8",
      },
    );
    // The three stored constants have no variable now: dropped, nothing refused.
    expect(report(out)).toMatchObject({
      result: MIGRATED,
      kept: 7,
      dropped: 3,
      refused: 0,
      added: 0,
    });
    const vals = dump(b.map, out);
    for (const [p, [, h]] of Object.entries(VALUES)) expect(vals[p], p).toBe(h);
    // The first save writes the image without them; it then restores as OK.
    const again = path.join(tempDir, "resaved.v2");
    execFileSync(
      b.bin,
      ["load", path.join(FIXTURES, "constfb.v2.bin"), "save", again],
      { encoding: "utf-8" },
    );
    expect(
      report(execFileSync(b.bin, ["load", again], { encoding: "utf-8" })),
    ).toMatchObject({
      result: OK,
      kept: 7,
      refused: 0,
    });
  });

  it("leaves a library block's CONSTANT out of a RETAIN instance", () => {
    const lib = compileStlib(
      [
        {
          fileName: "l.st",
          source: `FUNCTION_BLOCK FB_LIBC
VAR CONSTANT K : INT := 3; END_VAR
VAR x : DINT; END_VAR
  x := x + K;
END_FUNCTION_BLOCK`,
        },
      ],
      { name: "constlib", version: "1.0.0", namespace: "constlib" },
    );
    expect(lib.errors).toEqual([]);
    const archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    const b = build(
      "libconst",
      `PROGRAM Main
VAR RETAIN i : FB_LIBC; END_VAR
  i();
END_PROGRAM${CFG}`,
      [archive],
    );
    expect(b.map.retainVars!.map((v) => v.path)).toEqual(["INSTANCE0.I.X"]);
    const blob = path.join(tempDir, "lib.v2");
    execFileSync(b.bin, ["save", blob], { encoding: "utf-8" });
    expect(
      report(execFileSync(b.bin, ["load", blob], { encoding: "utf-8" })),
    ).toMatchObject({
      result: OK,
      refused: 0,
    });
  });
});
