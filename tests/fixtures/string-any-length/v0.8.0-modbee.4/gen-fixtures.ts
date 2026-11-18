// Builds the v0.8.0-modbee.4 reference fixtures for the string-any-length tests.
// Run from the extracted tag: npx vite-node gen-fixtures.ts <outDir>
import * as fs from "fs";
import * as path from "path";
import { execSync, execFileSync } from "child_process";
import { compile } from "./src/index.js";
import { compileStlib } from "./src/library/library-compiler.js";

const out = path.resolve(process.argv[2]!);
fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "strlen-gen-"));
const INC = path.resolve("src/runtime/include");

export const SMALL = `TYPE
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

export const LARGE = `PROGRAM Main
VAR RETAIN
  big : STRING(320);
  u : STRING;
  n : DINT;
END_VAR
  n := n;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const LIB = `TYPE
  S_LIB : STRUCT
    tag : STRING(20);
    w : WSTRING(8);
    n : INT;
    d : STRING;
  END_STRUCT;
END_TYPE`;

const HARNESS = fs.readFileSync(path.resolve("harness.cpp"), "utf-8");

function build(name: string, st: string): string {
  const r = compile(st, { headerFileName: "generated.hpp" });
  if (r.errors.length) throw new Error(r.errors.map((e) => e.message).join("\n"));
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "generated.hpp"), r.headerCode);
  fs.writeFileSync(path.join(dir, "generated.cpp"), r.cppCode);
  fs.writeFileSync(path.join(dir, "generated_debug.cpp"), r.debugTableCpp!);
  fs.writeFileSync(path.join(dir, "debug-map.json"), JSON.stringify(r.debugMap, null, 1));
  fs.writeFileSync(path.join(work, "main.cpp"), HARNESS);
  const bin = path.join(work, name);
  execSync(
    `g++ -std=c++14 -O0 -I"${INC}" -I"${dir}" -o "${bin}" "${work}/main.cpp" "${dir}/generated.cpp" "${dir}/generated_debug.cpp"`,
    { stdio: "inherit" },
  );
  return bin;
}

// Values set by debug path, as "arr elem kind hex" lines.
function values(mapFile: string, vals: Record<string, [string, string]>): string {
  const map = JSON.parse(fs.readFileSync(mapFile, "utf-8"));
  const lines: string[] = [];
  for (const [p, [kind, hex]] of Object.entries(vals)) {
    const l = map.leaves.find((x: { path: string }) => x.path === p);
    if (!l) throw new Error(`no leaf ${p}`);
    lines.push(`${l.arrayIdx} ${l.elemIdx} ${kind} ${hex}`);
  }
  const f = path.join(work, "vals.txt");
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

const hex = (s: string) => Buffer.from(s, "latin1").toString("hex");
const whex = (s: string) => Buffer.from(s, "utf16le").toString("hex");
const le = (n: number | bigint, w: number) => {
  const b = Buffer.alloc(w);
  if (w === 8) b.writeBigInt64LE(BigInt(n));
  else b.writeIntLE(Number(n), 0, w);
  return b.toString("hex");
};

export const SMALL_VALUES: Record<string, [string, string]> = {
  "CFG.NAME": ["t", hex("station-7")],
  "CFG.NOTE": ["t", hex("N".repeat(140) + "-end")],
  "CFG.WIDE": ["t", whex("wide-é中")],
  "CFG.FULL": ["t", hex("F".repeat(254))],
  "CFG.COUNT": ["s", le(-123456, 4)],
  "CFG.FLAGS[2]": ["s", le(77, 2)],
  "INSTANCE0.SL": ["t", hex("thirty-chars-exactly-0123456789")],
  "INSTANCE0.S254": ["t", hex("x".repeat(200))],
  "INSTANCE0.W": ["t", whex("w".repeat(130))],
  "INSTANCE0.HOURS": ["s", le(987654321012n, 8)],
};

const small = build("small", SMALL);
const sv = values(path.join(out, "small/debug-map.json"), SMALL_VALUES);
fs.writeFileSync(path.join(out, "small.values.json"), JSON.stringify(SMALL_VALUES, null, 1));
console.log(execFileSync(small, ["set", sv, "save2", path.join(out, "small.v2.bin"), "save1", path.join(out, "small.v1.bin")], { encoding: "utf-8" }));

const large = build("large", LARGE);
const LARGE_VALUES: Record<string, [string, string]> = {
  "INSTANCE0.BIG": ["t", hex("B".repeat(300))],
  "INSTANCE0.U": ["t", hex("u-value-" + "U".repeat(200))],
  "INSTANCE0.N": ["s", le(4242, 4)],
};
const lv = values(path.join(out, "large/debug-map.json"), LARGE_VALUES);
fs.writeFileSync(path.join(out, "large.values.json"), JSON.stringify(LARGE_VALUES, null, 1));
console.log(execFileSync(large, ["set", lv, "save2", path.join(out, "large.v2.bin")], { encoding: "utf-8" }));
// The program files of `large` are not needed later: only its blob.
fs.rmSync(path.join(out, "large"), { recursive: true });

const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
  name: "strlen-lib",
  version: "1.0.0",
  namespace: "strlenlib",
});
if (!lib.success) throw new Error(JSON.stringify(lib.errors));
fs.writeFileSync(path.join(out, "lib.stlib.json"), JSON.stringify(lib.archive));
fs.rmSync(work, { recursive: true });
console.log("done", out);
