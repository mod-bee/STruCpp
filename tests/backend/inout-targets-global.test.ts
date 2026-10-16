/**
 * In-out targets of GLOBAL block instances. A program reaches a global instance through VAR_EXTERNAL and
 * calls it; the in-out's leaves then have the variable the calls bind as their `target`, so the debugger
 * can force them there (an in-out leaf is a read-only view of that variable). Before, only instances
 * declared inside a program were looked at, so every in-out of a global instance was unforceable.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";

const source = (secondCall: string) => `
TYPE Rec : STRUCT n : INT; s : STRING(8); END_STRUCT; END_TYPE
TYPE Plant : STRUCT a : Rec; b : Rec; out : ARRAY[1..3] OF Rec; END_STRUCT; END_TYPE

FUNCTION_BLOCK Holder
  VAR_IN_OUT Data : Rec; END_VAR
  Data.n := Data.n + 1;
END_FUNCTION_BLOCK

PROGRAM One
  VAR_EXTERNAL dev : Plant; h : Holder; hs : ARRAY[1..2] OF Holder; SLOT : INT; END_VAR
  h(Data := dev.a);
  hs[1](Data := dev.out[SLOT]);
  hs[2](Data := dev.out[3]);
END_PROGRAM

PROGRAM Two
  VAR_EXTERNAL dev : Plant; h : Holder; END_VAR
  ${secondCall}
END_PROGRAM

CONFIGURATION Config0
  VAR_GLOBAL
    dev : Plant;
    h : Holder;
    hs : ARRAY[1..2] OF Holder;
  END_VAR
  VAR_GLOBAL CONSTANT SLOT : INT := 2; END_VAR
  RESOURCE Res ON PLC
    TASK T(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM P1 WITH T : One;
    PROGRAM P2 WITH T : Two;
  END_RESOURCE
END_CONFIGURATION
`;

const leaves = (secondCall: string) => {
  const result = compile(source(secondCall));
  expect(result.errors).toEqual([]);
  const map = result.debugMap as { leaves: Array<{ path: string; target?: string; indirect?: boolean }> };
  return new Map(map.leaves.map((leaf) => [leaf.path, leaf]));
};

describe("in-out targets of global instances", () => {
  it("names the bound global member, when every program binds the same one", () => {
    const byPath = leaves("h(Data := dev.a);");
    expect(byPath.get("H.DATA.N")).toMatchObject({ indirect: true, target: "DEV.A.N" });
    expect(byPath.get("H.DATA.S")).toMatchObject({ indirect: true, target: "DEV.A.S" });
  });

  it("names none when two programs bind different variables", () => {
    const byPath = leaves("h(Data := dev.b);");
    expect(byPath.get("H.DATA.N")?.indirect).toBe(true);
    expect(byPath.get("H.DATA.N")?.target).toBeUndefined();
  });

  it("resolves an element of a global array of instances, and a subscript naming a constant", () => {
    const byPath = leaves("h(Data := dev.a);");
    expect(byPath.get("HS[1].DATA.N")).toMatchObject({ target: "DEV.OUT[2].N" });
    expect(byPath.get("HS[2].DATA.N")).toMatchObject({ target: "DEV.OUT[3].N" });
  });
});
