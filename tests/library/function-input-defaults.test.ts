// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Tests for capturing VAR_INPUT initial values into the library manifest.
 *
 * Manifest parameter shape carries an optional `initialValue` (ST expression
 * string). Present ⇒ the input is optional (compiler supplies the default when
 * omitted); absent ⇒ the input is mandatory. This must be populated from the
 * source ST for both user-authored library projects and CODESYS-imported
 * libraries — the latter flow through the same compileStlib path, since the
 * importer emits ST source verbatim (declarations, including `:=` defaults).
 */

import { describe, it, expect } from "vitest";
import { compileStlib } from "../../src/library/library-compiler.js";
import { compile } from "../../src/index.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

function fnParams(source: string, fnName: string) {
  const result = compileStlib([{ source, fileName: "lib.st" }], {
    name: "test-lib",
    version: "1.0.0",
    namespace: "test",
  });
  expect(result.success).toBe(true);
  const fn = result.archive!.manifest.functions.find((f) => f.name === fnName);
  expect(fn).toBeDefined();
  return fn!.parameters;
}

describe("library manifest: VAR_INPUT initial values", () => {
  it("captures initialValue for defaulted inputs and omits it for mandatory ones", () => {
    const params = fnParams(
      `
      FUNCTION SCALE_DEMO : REAL
        VAR_INPUT
          IN : REAL;
          MAXV : REAL := 1000.0;
          SIGN : BYTE := 255;
        END_VAR
        SCALE_DEMO := IN;
      END_FUNCTION
    `,
      "SCALE_DEMO",
    );

    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    // mandatory input — no default
    expect(byName.IN).toMatchObject({ name: "IN", direction: "input" });
    expect("initialValue" in byName.IN!).toBe(false);
    // optional inputs — defaults preserved as ST strings
    expect(byName.MAXV!.initialValue).toBe("1000.0");
    expect(byName.SIGN!.initialValue).toBe("255");
  });

  it("serializes common default-expression forms", () => {
    const params = fnParams(
      `
      FUNCTION DEFAULTS : INT
        VAR_INPUT
          a : INT := -1;
          b : BOOL := TRUE;
          c : TIME := T#100ms;
          d : REAL := 3.14;
        END_VAR
        DEFAULTS := a;
      END_FUNCTION
    `,
      "DEFAULTS",
    );
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    // Manifest normalizes parameter names to upper case.
    expect(byName.A!.initialValue).toBe("-1");
    expect(byName.B!.initialValue).toBe("TRUE");
    expect(byName.C!.initialValue).toBe("T#100MS"); // time literals normalize upper-case
    expect(byName.D!.initialValue).toBe("3.14");
  });

  it("preserves initialValue when reloaded from a serialized .stlib (round-trip)", () => {
    const result = compileStlib(
      [
        {
          source: `
          FUNCTION F : INT
            VAR_INPUT x : INT; y : INT := 7; END_VAR
            F := x + y;
          END_FUNCTION
        `,
          fileName: "lib.st",
        },
      ],
      { name: "rt-lib", version: "1.0.0", namespace: "rt" },
    );
    expect(result.success).toBe(true);

    // Round-trip through JSON, as the .stlib is persisted/loaded.
    const json = JSON.parse(JSON.stringify(result.archive));
    const fn = json.manifest.functions.find(
      (f: { name: string }) => f.name === "F",
    );
    const byName = Object.fromEntries(
      fn.parameters.map((p: { name: string }) => [p.name, p]),
    );
    expect("initialValue" in byName.X).toBe(false);
    expect(byName.Y.initialValue).toBe("7");
  });

  it("captures defaults from CODESYS-importer-style ST (same compileStlib path)", () => {
    // The CODESYS v2/v3 importers emit ST source verbatim; an imported OSCAT
    // function like AIN carries VAR_INPUT defaults that must reach the manifest.
    const params = fnParams(
      `
      FUNCTION AIN : REAL
        VAR_INPUT
          IN : DWORD;
          sign : BYTE := 255;
          high : REAL := 10.0;
        END_VAR
        AIN := high;
      END_FUNCTION
    `,
      "AIN",
    );
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect("initialValue" in byName.IN!).toBe(false);
    expect(byName.SIGN!.initialValue).toBe("255");
    expect(byName.HIGH!.initialValue).toBe("10.0");
  });
});

describe("library manifest: function-block VAR_INPUT initial values", () => {
  it("captures an FB input's default and omits it for inputs without one", () => {
    const result = compileStlib(
      [
        {
          source: `
          FUNCTION_BLOCK LINK_DEMO
            VAR_INPUT
              CONNECT : BOOL := TRUE;
              HOST : STRING(32);
              PERIOD : TIME := T#10s;
            END_VAR
            VAR_OUTPUT
              READY : BOOL := FALSE;
            END_VAR
            READY := CONNECT;
          END_FUNCTION_BLOCK
        `,
          fileName: "lib.st",
        },
      ],
      { name: "test-lib", version: "1.0.0", namespace: "test" },
    );
    expect(result.success).toBe(true);
    const fb = result.archive!.manifest.functionBlocks.find((f) => f.name === "LINK_DEMO");
    expect(fb).toBeDefined();
    const byName = Object.fromEntries(fb!.inputs.map((p) => [p.name, p]));
    expect(byName.CONNECT!.initialValue).toBe("TRUE");
    expect(byName.PERIOD!.initialValue).toBeDefined();
    expect("initialValue" in byName.HOST!).toBe(false);
    // Only inputs carry it: an output's initial value is not a call-site default.
    expect("initialValue" in fb!.outputs[0]!).toBe(false);
  });
});

// release-0.7 (0.7.0-modbee.5): defaults that were dropped, and a block's constants a method default names.
describe("library manifest: defaults recorded as written", () => {
  const lib = `
    TYPE
      {attribute 'qualified_only'}
      E_U : (None, Bar) := None;
      ST_C : STRUCT eU : E_U; n : INT; END_STRUCT;
    END_TYPE
    FUNCTION F_D : INT
      VAR_INPUT
        a : E_U := E_U.Bar;
        s : ST_C := (eU := E_U.Bar, n := 2);
        arr : ARRAY[1..2] OF INT := [3, 4];
      END_VAR
      F_D := s.n;
    END_FUNCTION
    FUNCTION_BLOCK FB_P
      VAR CONSTANT cPort : INT := 1883; END_VAR
      METHOD PUBLIC Port : INT
        VAR_INPUT n : INT := cPort; e : E_U := E_U.Bar; END_VAR
        Port := n;
      END_METHOD
    END_FUNCTION_BLOCK
  `;
  const built = () =>
    compileStlib([{ source: lib, fileName: "lib.st" }], { name: "d-lib", version: "1.0.0", namespace: "d" });

  it("records a qualified enumeration value, a struct literal and an array literal", () => {
    const result = built();
    expect(result.success).toBe(true);
    const fn = result.archive!.manifest.functions.find((f) => f.name === "F_D")!;
    const by = Object.fromEntries(fn.parameters.map((p) => [p.name, p.initialValue]));
    expect(by.A).toMatch(/^E_U\.BAR$/i);
    expect(by.S).toMatch(/^\(EU := E_U\.BAR, N := 2\)$/i);
    expect(by.ARR).toBe("[3, 4]");
    const fb = result.archive!.manifest.functionBlocks.find((b) => b.name === "FB_P")!;
    const m = fb.methods!.find((x) => x.name === "PORT")!;
    expect(m.inputs.find((i) => i.name === "E")!.initialValue).toMatch(/^E_U\.BAR$/i);
  });

  it("records a block's constants with their values", () => {
    const fb = built().archive!.manifest.functionBlocks.find((b) => b.name === "FB_P")!;
    expect(fb.locals?.find((l) => l.name === "CPORT")).toMatchObject({ readOnly: true, initialValue: "1883" });
  });

  it("a consumer resolves a method default naming the block's constant", () => {
    // An archive whose method default names the constant (as 0.8 records it)
    const archive = JSON.parse(JSON.stringify(built().archive)) as StlibArchive;
    const fb = archive.manifest.functionBlocks.find((b) => b.name === "FB_P")!;
    fb.methods!.find((x) => x.name === "PORT")!.inputs.find((i) => i.name === "N")!.initialValue = "cPort";
    const r = compile(`PROGRAM P VAR p : FB_P; x : INT; END_VAR x := p.Port(); END_PROGRAM`, {
      libraries: [archive],
    });
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toMatch(/P\.PORT\(\(1883\), E_U::BAR\)/);
  });
});
