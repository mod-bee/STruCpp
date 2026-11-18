/**
 * STRING(n) / WSTRING(n) of any declared length, 1 to 65535: the compile side.
 *
 * S5  the debug table and the debug map carry the real declared length, named
 *     lengths included, and the retain size counts it (format 3 once a
 *     retained string is longer than 254);
 * S6  a declared length outside 1..65535 is a compile error (IEC 61131-3:2013
 *     6.4.2.2 and Table 10 footnote k: the maximum is Implementer specific);
 * S9  a retain image over 65535 bytes is a compile error naming the size.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const CFG = `
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

function build(source: string) {
  const result = compile(source, { headerFileName: "generated.hpp" });
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result;
}

function errorsOf(source: string): string[] {
  return compile(source).errors.map((e) => e.message);
}

function leaf(result: ReturnType<typeof compile>, path: string) {
  const l = result.debugMap!.leaves.find((x) => x.path === path);
  expect(l, `no leaf ${path}`).toBeTruthy();
  return l!;
}

describe("S5: the real declared length in the tables, the map and the retain size", () => {
  const SOURCE = `VAR_GLOBAL CONSTANT GLEN : INT := 400; END_VAR
TYPE
  REC_T : STRUCT
    tag : STRING(GLEN);
    w : WSTRING(300);
  END_STRUCT;
END_TYPE
PROGRAM Main
VAR CONSTANT LLEN : INT := 2 * 150 + 20; END_VAR
VAR
  s : STRING(320);
  w : WSTRING(300);
  u : STRING;
  short : STRING(20);
  named : STRING(LLEN);
  rec : REC_T;
END_VAR
  s := s;
END_PROGRAM${CFG}`;

  it("emits each string's real length in the debug table", () => {
    const cpp = build(SOURCE).debugTableCpp!;
    const row = (path: string, tag: string, cap: number) =>
      new RegExp(
        `${tag}, 0, ${cap} \\},\\s+// ${path.replace(/\./g, "\\.")}$`,
        "m",
      );
    expect(cpp).toMatch(row("INSTANCE0.S", "TAG_STRING", 320));
    expect(cpp).toMatch(row("INSTANCE0.W", "TAG_WSTRING", 300));
    expect(cpp).toMatch(row("INSTANCE0.SHORT", "TAG_STRING", 20));
    // A named length is resolved by the compiler, not left to the C++ type.
    expect(cpp).toMatch(row("INSTANCE0.NAMED", "TAG_STRING", 320));
    expect(cpp).toMatch(row("INSTANCE0.REC.TAG", "TAG_STRING", 400));
  });

  it("gives every string leaf in the debug map its declared length", () => {
    const result = build(SOURCE);
    expect(leaf(result, "INSTANCE0.S").cap).toBe(320);
    expect(leaf(result, "INSTANCE0.W").cap).toBe(300);
    expect(leaf(result, "INSTANCE0.U").cap).toBe(254);
    expect(leaf(result, "INSTANCE0.SHORT").cap).toBe(20);
    expect(leaf(result, "INSTANCE0.NAMED").cap).toBe(320);
    expect(leaf(result, "INSTANCE0.REC.TAG").cap).toBe(400);
    expect(leaf(result, "INSTANCE0.REC.W").cap).toBe(300);
    // Only strings carry it.
    expect(
      result.debugMap!.leaves.some(
        (l) => l.type !== "STRING" && l.type !== "WSTRING" && "cap" in l,
      ),
    ).toBe(false);
    // The map version does not change.
    expect(result.debugMap!.version).toBe(2);
  });

  it("emits a named length as the number in the C++ types", () => {
    const result = build(SOURCE);
    expect(result.headerCode).toContain("IECStringVar<320> NAMED");
    expect(result.headerCode).toContain("IECStringVar<400> TAG");
  });

  it("sizes a format-3 retain blob from the real lengths", () => {
    const result = build(`VAR_GLOBAL CONSTANT GLEN : INT := 400; END_VAR
PROGRAM Main
VAR RETAIN
  s : STRING(320);
  w : WSTRING(300);
  g : STRING(GLEN);
  n : DINT;
  a : ARRAY[1..3] OF INT;
END_VAR
  n := n;
END_PROGRAM${CFG}`);
    const map = result.debugMap!;
    expect(map.retainFormat).toBe(3);
    // header 14; payload: [u16 len] + 320, [u16 len] + 600, [u16 len] + 400,
    // DINT 4, 3 INT 6; trailer: 4 + four singles of 7 + one run of 13.
    expect(map.retainBlobSize).toBe(
      14 + 322 + 602 + 402 + 4 + 6 + 4 + 4 * 7 + 13,
    );
    expect(result.debugTableCpp).toMatch(
      /0x[0-9a-f]{8}u, RETAIN_NO_INDEX, TAG_STRING, 320, 0 \}/,
    );
    expect(result.debugTableCpp).toMatch(
      /0x[0-9a-f]{8}u, RETAIN_NO_INDEX, TAG_STRING, 400, 0 \}/,
    );
  });

  it("keeps format 2 and its size for a program whose strings are all 254 or shorter", () => {
    const result = build(`PROGRAM Main
VAR RETAIN
  s : STRING(254);
  u : STRING;
  w : WSTRING(10);
  n : DINT;
END_VAR
  n := n;
END_PROGRAM${CFG}`);
    expect(result.debugMap!.retainFormat).toBe(2);
    // header 14; payload 255 + 255 + 21 + 4; trailer 4 + 4 * 6.
    expect(result.debugMap!.retainBlobSize).toBe(
      14 + 255 + 255 + 21 + 4 + 4 + 24,
    );
  });

  it("checks the retained string lengths against the C++ types", () => {
    const result = build(`PROGRAM Main
VAR RETAIN s : STRING(320); u : STRING; n : DINT; END_VAR
  n := n;
END_PROGRAM${CFG}`);
    expect(result.debugTableCpp).toMatch(
      /static_assert\([^;]*string_cap<decltype\([^;]*INSTANCE0\.S\)>::value[^;]*retain/,
    );
  });
});

describe("S6: a declared length outside 1..65535 is a compile error", () => {
  const prog = (decl: string, pre = "") =>
    `${pre}PROGRAM Main
VAR ${decl} END_VAR
END_PROGRAM${CFG}`;

  it.each([
    ["s : STRING(0);", "0"],
    ["s : STRING(65536);", "65536"],
    ["w : WSTRING(0);", "0"],
    ["w : WSTRING(70000);", "70000"],
  ])("refuses %s", (decl, n) => {
    const errors = errorsOf(prog(decl));
    expect(errors.some((m) => m.includes(n) && /1 to 65535/.test(m))).toBe(
      true,
    );
  });

  it("accepts 1 and 65535", () => {
    expect(
      errorsOf(prog("a : STRING(1); b : WSTRING(65535); c : STRING(65535);")),
    ).toEqual([]);
  });

  it("refuses a named length outside the range", () => {
    const errors = errorsOf(
      prog(
        "s : STRING(BIG);",
        "VAR_GLOBAL CONSTANT BIG : DINT := 70000; END_VAR\n",
      ),
    );
    expect(
      errors.some((m) => m.includes("70000") && /1 to 65535/.test(m)),
    ).toBe(true);
    const local = errorsOf(`PROGRAM Main
VAR CONSTANT Z : INT := 0; END_VAR
VAR s : STRING(Z); END_VAR
END_PROGRAM${CFG}`);
    expect(local.some((m) => /1 to 65535/.test(m))).toBe(true);
  });

  it("refuses it in a STRUCT member and a TYPE alias", () => {
    const errors = errorsOf(`TYPE
  R : STRUCT a : STRING(0); END_STRUCT;
  S_BIG : WSTRING(65536);
END_TYPE
PROGRAM Main
VAR r : R; s : S_BIG; END_VAR
END_PROGRAM${CFG}`);
    expect(errors.filter((m) => /1 to 65535/.test(m)).length).toBe(2);
  });
});

describe("S9: a retain image over 65535 bytes is a compile error", () => {
  it("refuses it and names the size", () => {
    const result = compile(`PROGRAM Main
VAR RETAIN a : ARRAY[1..300] OF STRING(254); END_VAR
END_PROGRAM${CFG}`);
    const messages = result.errors.map((e) => e.message);
    // header 14; payload 300 * 255; trailer 4 + one run of 12.
    const size = 14 + 300 * 255 + 4 + 12;
    expect(
      messages.some((m) => m.includes(String(size)) && m.includes("65535")),
    ).toBe(true);
    expect(result.success).toBe(false);
  });

  it("refuses one string longer than the image can hold", () => {
    const messages = compile(`PROGRAM Main
VAR RETAIN s : STRING(65535); END_VAR
END_PROGRAM${CFG}`).errors.map((e) => e.message);
    expect(
      messages.some((m) => m.includes(String(14 + 2 + 65535 + 4 + 7))),
    ).toBe(true);
  });

  it("builds a retain image of exactly 65535 bytes", () => {
    // header 14 + [u16 len] + n + trailer 4 + 7 = 65535.
    const n = 65535 - 14 - 2 - 4 - 7;
    const result = compile(`PROGRAM Main
VAR RETAIN s : STRING(${n}); END_VAR
END_PROGRAM${CFG}`);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.debugMap!.retainBlobSize).toBe(65535);
  });
});
