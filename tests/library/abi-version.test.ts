/**
 * The library calling-convention stamp (STRUCPP_ABI_VERSION): a library built
 * by this compiler is stamped and loads; one built for another convention (or
 * unstamped, i.e. older) is refused with a plain error naming it, before any
 * C++ is generated, instead of failing later as a C++ compile or link error.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { loadStlibFromString } from "../../src/library/library-loader.js";
import {
  STRUCPP_ABI_VERSION,
  type StlibArchive,
} from "../../src/library/library-manifest.js";

const LIB = `
FUNCTION F_Split : DINT
  VAR_INPUT n : DINT; END_VAR
  VAR_OUTPUT nHigh : DINT; END_VAR
  nHigh := n / 100;
  F_Split := n MOD 100;
END_FUNCTION
`;

const USER = `
PROGRAM P
  VAR h, r : DINT; END_VAR
  r := F_Split(n := 1234, nHigh => h);
END_PROGRAM
`;

const build = (): StlibArchive => {
  const built = compileStlib([{ fileName: "split.st", source: LIB }], {
    name: "split-lib",
    version: "2.1.0",
    namespace: "splitlib",
  });
  expect(built.errors).toEqual([]);
  return JSON.parse(JSON.stringify(built.archive)) as StlibArchive;
};

const errorsWith = (archive: StlibArchive): string[] =>
  compile(USER, { libraries: [archive] }).errors.map((e) => e.message);

describe("the library calling-convention stamp", () => {
  it("stamps an archive, keeps the stamp through a load, and accepts it", () => {
    const archive = build();
    expect(archive.abiVersion).toBe(STRUCPP_ABI_VERSION);
    const reloaded = loadStlibFromString(JSON.stringify(archive));
    expect(reloaded.abiVersion).toBe(STRUCPP_ABI_VERSION);
    const result = compile(USER, { libraries: [reloaded] });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).toContain("F_SPLIT(");
  });

  it("refuses an unstamped (older) archive with a plain error", () => {
    const archive = build();
    delete archive.abiVersion;
    const result = compile(USER, { libraries: [archive] });
    expect(result.success).toBe(false);
    expect(result.cppCode).toBe("");
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(
        /^library split-lib 2\.1\.0 was built for an older compiler \(calling convention 1; this one needs \d+\): reinstall it from a release built with STruC\+\+ .* or later, or rebuild it$/,
      ),
    ]);
  });

  it("refuses an archive stamped for an older or a newer convention", () => {
    const older = build();
    older.abiVersion = STRUCPP_ABI_VERSION - 1;
    expect(errorsWith(older)).toEqual([
      expect.stringContaining("was built for an older compiler"),
    ]);
    const newer = build();
    newer.abiVersion = STRUCPP_ABI_VERSION + 1;
    expect(errorsWith(newer)).toEqual([
      expect.stringContaining(
        "library split-lib 2.1.0 was built for a newer compiler",
      ),
    ]);
  });

  it("does not check an archive with no C++ (symbol entries only)", () => {
    const archive = build();
    delete archive.abiVersion;
    archive.chunks = [];
    const messages = errorsWith(archive);
    expect(messages.some((m) => m.includes("calling convention"))).toBe(false);
  });
});
