// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Library Loader
 *
 * Loads library manifests and registers their symbols into the symbol tables
 * for cross-library function resolution.
 */

import type {
  LibraryFBEntry,
  LibraryInterfaceEntry,
  LibraryManifest,
  LibraryMethodEntry,
  LibraryPropertyEntry,
  LibraryTypeEntry,
  LibraryVarType,
  StlibArchive,
} from "./library-manifest.js";
import type { SymbolTables, VariableSymbol } from "../semantic/symbol-table.js";
import { DuplicateSymbolError } from "../semantic/symbol-table.js";
import { HEADER_NAME_RE } from "./library-manifest.js";
import { walkAST } from "../ast-utils.js";
import { parse as parseSource } from "../frontend/parser.js";
import { buildAST } from "../frontend/ast-builder.js";
import type {
  ElementaryType,
  EnumType,
  Expression,
  FunctionBlockDeclaration,
  IECType,
  InterfaceDeclaration,
  MethodDeclaration,
  PropertyDeclaration,
  ReferenceKind,
  StructDefinition,
  StructType,
  TypeReference,
  VarBlock,
  VarBlockType,
  VarDeclaration,
  VariableExpression,
} from "../frontend/ast.js";
import { createDefaultSourceSpan } from "../frontend/ast.js";
import { parseInitialValueText } from "../frontend/expression-text.js";
import { qualifiedEnumValue } from "../frontend/type-defaults.js";
import { ELEMENTARY_TYPES } from "../semantic/type-utils.js";

/**
 * Error thrown when a library manifest fails validation.
 */
export class LibraryManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryManifestError";
  }
}

/** Build a TypeReference AST node from a manifest variable entry. The
 *  reference preserves the metadata downstream consumers (codegen,
 *  debug-table-gen) need to recurse into nested types. */
function makeTypeRef(v: LibraryVarType): TypeReference {
  // Archive JSON is external input: keep only kinds the compiler writes.
  const referenceKind: ReferenceKind = isReferenceKind(v.referenceKind)
    ? v.referenceKind
    : "none";
  const ref: TypeReference = {
    kind: "TypeReference",
    sourceSpan: createDefaultSourceSpan(),
    name: v.type,
    isReference: referenceKind !== "none",
    referenceKind,
  };
  if (v.arrayDimensions) ref.arrayDimensions = v.arrayDimensions;
  if (v.elementTypeName) ref.elementTypeName = v.elementTypeName;
  if (v.elementReferenceChain) {
    ref.elementReferenceChain = v.elementReferenceChain.filter(isReferenceKind);
  }
  if (v.referenceChain) {
    ref.referenceChain = v.referenceChain.filter(isReferenceKind);
  }
  return ref;
}

function isReferenceKind(
  kind: unknown,
): kind is "pointer_to" | "ref_to" | "reference_to" {
  return kind === "pointer_to" || kind === "ref_to" || kind === "reference_to";
}

/** Create a VariableSymbol from a library variable entry. The synthesized
 *  VarDeclaration carries the real TypeReference so AST-walking consumers
 *  (debug-table-gen) can recurse uniformly across user-defined and
 *  library-defined function blocks. */
/**
 * The AST definition a library type is registered under.
 *
 * A struct that exported its fields gets a real `StructDefinition`, so anything
 * walking the type — the debug table above all — can descend into its members.
 * Everything else keeps the historical self-referential `TypeReference`, which
 * the walk reads as "opaque library type": an alias points at its base, and a
 * struct without exported fields genuinely has nothing to descend into.
 */
function buildLibraryTypeDefinition(
  t: LibraryTypeEntry,
): StructDefinition | TypeReference {
  if (t.kind === "struct" && t.fields && t.fields.length > 0) {
    return {
      kind: "StructDefinition",
      sourceSpan: createDefaultSourceSpan(),
      ...(t.extends !== undefined ? { extends: t.extends } : {}),
      fields: t.fields.map((f) => ({
        kind: "VarDeclaration" as const,
        sourceSpan: createDefaultSourceSpan(),
        names: [f.name],
        declaredNames: [f.displayName ?? f.name],
        type: makeSizedTypeRef(f),
      })),
    };
  }
  return {
    kind: "TypeReference",
    sourceSpan: createDefaultSourceSpan(),
    name: t.baseType ?? t.name,
    isReference: false,
    referenceKind: "none",
  };
}

/** {@link makeTypeRef} plus the declared STRING lengths, which size the member. */
function makeSizedTypeRef(v: LibraryVarType): TypeReference {
  const ref = makeTypeRef(v);
  if (typeof v.maxLength === "number") ref.maxLength = v.maxLength;
  if (typeof v.elementMaxLength === "number") {
    ref.elementMaxLength = v.elementMaxLength;
  }
  return ref;
}

function makeVarSymbol(
  v: LibraryVarType,
  direction: "input" | "output" | "inout" | "local",
): VariableSymbol {
  const varType: ElementaryType = ELEMENTARY_TYPES[v.type.toUpperCase()] ?? {
    typeKind: "elementary",
    name: v.type,
    sizeBits: 0,
  };
  const declaration: VarDeclaration = {
    kind: "VarDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    names: [v.name],
    type: makeSizedTypeRef(v),
  };
  return {
    name: v.name,
    kind: "variable",
    type: varType,
    declaration,
    isInput: direction === "input",
    isOutput: direction === "output",
    isInOut: direction === "inout",
    isExternal: false,
    isGlobal: false,
    // A `VAR RETAIN` inside the library is retained in every instance of the
    // block, whatever the instance's own qualifier — so the manifest's flag
    // travels onto the symbol rather than being re-derived at the use site.
    isRetain: v.retain === true,
    // A `NON_RETAIN` member stays out of a RETAIN instance (6.5.6.2).
    ...(v.nonRetain === true ? { isNonRetain: true } : {}),
    // Only present when the library's codegen mangled the member; the walk
    // prefers it over re-deriving the rule against the wrong unit.
    ...(v.cppName !== undefined ? { cppName: v.cppName } : {}),
  };
}

/**
 * The manifest's `headers`, each emitted as `#include "<name>"` into every
 * program using the library: refused unless every entry is a plain relative
 * file name, so an archive cannot splice code into the consumer's build.
 */
function validateHeaders(headers: unknown): string[] {
  if (headers === undefined) return [];
  if (!Array.isArray(headers)) {
    throw new LibraryManifestError(
      "Invalid library manifest: headers must be an array",
    );
  }
  return headers.map((h: unknown, i) => {
    if (typeof h !== "string" || !HEADER_NAME_RE.test(h)) {
      throw new LibraryManifestError(
        `Invalid library manifest: headers[${i}] must be a relative file name without '.' or '..' segments (letters, digits, '.', '/', '-', '_', '+')`,
      );
    }
    return h;
  });
}

/**
 * Refuses malformed descriptive fields along every exported declaration of a
 * raw manifest: `attributes` must be a list of named attribute pragmas, and
 * `displayName`, `initialValue` and `value` strings.
 */
function validateDescriptions(obj: Record<string, unknown>): void {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const one = (owner: unknown, where: string): void => {
    if (!isRecord(owner)) return;
    for (const key of ["displayName", "initialValue", "value"] as const) {
      if (owner[key] !== undefined && typeof owner[key] !== "string") {
        throw new LibraryManifestError(
          `Invalid library manifest: ${where}.${key} must be a string`,
        );
      }
    }
    if (owner.attributes === undefined) return;
    if (!Array.isArray(owner.attributes)) {
      throw new LibraryManifestError(
        `Invalid library manifest: ${where}.attributes must be an array`,
      );
    }
    owner.attributes.forEach((a: unknown, k) => {
      if (
        !isRecord(a) ||
        typeof a.name !== "string" ||
        a.name === "" ||
        (a.value !== undefined && typeof a.value !== "string")
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: ${where}.attributes[${k}] must have a non-empty string name and an optional string value`,
        );
      }
    });
  };
  const list = (owner: unknown, key: string, where: string): void => {
    if (!isRecord(owner) || !Array.isArray(owner[key])) return;
    (owner[key] as unknown[]).forEach((e, k) =>
      one(e, `${where}.${key}[${k}]`),
    );
  };
  const method = (m: unknown, where: string): void => {
    one(m, where);
    for (const key of ["inputs", "outputs", "inouts"]) list(m, key, where);
  };
  const each = (key: string, fn: (e: unknown, where: string) => void): void => {
    if (!Array.isArray(obj[key])) return;
    (obj[key] as unknown[]).forEach((e, i) => fn(e, `${key}[${i}]`));
  };
  const VISIBILITIES = ["PUBLIC", "PRIVATE", "PROTECTED", "INTERNAL"];
  const named = (e: unknown, at: string): Record<string, unknown> => {
    if (!isRecord(e) || typeof e.name !== "string" || e.name === "") {
      throw new LibraryManifestError(
        `Invalid library manifest: ${at}.name must be a non-empty string`,
      );
    }
    return e;
  };
  // Methods and properties of a block or an interface: named entries with a
  // known visibility, methods with their three parameter lists of named
  // entries.
  const members = (owner: unknown, where: string): void => {
    if (!isRecord(owner)) return;
    for (const key of ["methods", "properties"] as const) {
      const entries = owner[key];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) {
        throw new LibraryManifestError(
          `Invalid library manifest: ${where}.${key} must be an array`,
        );
      }
      entries.forEach((e: unknown, j) => {
        const at = `${where}.${key}[${j}]`;
        const m = named(e, at);
        if (
          typeof m.visibility !== "string" ||
          !VISIBILITIES.includes(m.visibility)
        ) {
          throw new LibraryManifestError(
            `Invalid library manifest: ${at}.visibility must be PUBLIC, PRIVATE, PROTECTED or INTERNAL`,
          );
        }
        if (key !== "methods") return;
        for (const params of ["inputs", "outputs", "inouts"] as const) {
          if (!Array.isArray(m[params])) {
            throw new LibraryManifestError(
              `Invalid library manifest: ${at}.${params} must be an array`,
            );
          }
          (m[params] as unknown[]).forEach((v, k) =>
            named(v, `${at}.${params}[${k}]`),
          );
        }
      });
    }
  };
  each("functionBlocks", (fb, where) => members(fb, where));
  each("interfaces", (iface, where) => {
    named(iface, where);
    members(iface, where);
  });
  each("functions", (fn, where) => {
    one(fn, where);
    list(fn, "parameters", where);
  });
  each("functionBlocks", (fb, where) => {
    one(fb, where);
    for (const key of ["inputs", "outputs", "inouts", "locals"]) {
      list(fb, key, where);
    }
    if (isRecord(fb) && Array.isArray(fb.methods)) {
      fb.methods.forEach((m: unknown, j) =>
        method(m, `${where}.methods[${j}]`),
      );
    }
    if (isRecord(fb) && fb.fbInit !== undefined) {
      method(fb.fbInit, `${where}.fbInit`);
    }
  });
  each("types", (t, where) => {
    one(t, where);
    list(t, "fields", where);
    list(t, "members", where);
  });
  each("globals", (g, where) => one(g, where));
  each("interfaces", (iface, where) => {
    one(iface, where);
    if (isRecord(iface) && Array.isArray(iface.methods)) {
      iface.methods.forEach((m: unknown, j) =>
        method(m, `${where}.methods[${j}]`),
      );
    }
    if (isRecord(iface) && Array.isArray(iface.properties)) {
      iface.properties.forEach((p: unknown, j) => {
        one(p, `${where}.properties[${j}]`);
        if (isRecord(p)) one(p.type, `${where}.properties[${j}].type`);
      });
    }
  });
}

/**
 * Whether each default value text is exactly one ST expression, in one
 * parse; undefined when any is not (a text that closes the generated
 * declaration and adds its own is refused).
 */
function parsesAsInitialValues(texts: readonly string[]): boolean {
  if (texts.length === 0) return true;
  const lines = texts.map((t, i) => `  __D${i} : DINT := ${t};`);
  const parsed = parseSource(
    `PROGRAM __DEFAULTS\nVAR\n${lines.join("\n")}\nEND_VAR\nEND_PROGRAM\n`,
  );
  if (parsed.cst === null || parsed.errors.length > 0) return false;
  const ast = buildAST(parsed.cst);
  const others =
    ast.functions.length +
    ast.functionBlocks.length +
    ast.interfaces.length +
    ast.types.length +
    ast.configurations.length +
    ast.globalVarBlocks.length;
  const program = ast.programs[0];
  if (ast.programs.length !== 1 || others > 0 || program === undefined) {
    return false;
  }
  if (program.varBlocks.length !== 1 || program.body.length > 0) return false;
  const decls = program.varBlocks[0]?.declarations ?? [];
  return (
    decls.length === texts.length &&
    decls.every(
      (d, i) =>
        d.names.length === 1 &&
        d.names[0]?.toUpperCase() === `__D${i}` &&
        d.initialValue !== undefined,
    )
  );
}

/**
 * Refuses a parameter default that is not exactly one ST expression: a
 * consumer fills an omitted input with it, so it must not be able to splice
 * declarations of its own into the consumer's code.
 */
function validateDefaults(obj: Record<string, unknown>): void {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const check = (params: unknown, where: string): void => {
    if (!Array.isArray(params)) return;
    const withDefault = params.filter(
      (p): p is Record<string, unknown> =>
        isRecord(p) && typeof p.initialValue === "string",
    );
    if (parsesAsInitialValues(withDefault.map((p) => String(p.initialValue))))
      return;
    const bad = withDefault.find(
      (p) => !parsesAsInitialValues([String(p.initialValue)]),
    );
    throw new LibraryManifestError(
      `Invalid library manifest: ${where}: the default value '${String(bad?.initialValue ?? "")}' of parameter '${String(bad?.name ?? "")}' is not an ST expression`,
    );
  };
  const method = (m: unknown, where: string): void => {
    if (isRecord(m)) check(m.inputs, `${where}.inputs`);
  };
  const each = (key: string, fn: (e: unknown, where: string) => void): void => {
    if (!Array.isArray(obj[key])) return;
    (obj[key] as unknown[]).forEach((e, i) => fn(e, `${key}[${i}]`));
  };
  each("functions", (fn, where) => {
    if (isRecord(fn)) check(fn.parameters, `${where}.parameters`);
  });
  each("functionBlocks", (fb, where) => {
    if (!isRecord(fb)) return;
    check(fb.inputs, `${where}.inputs`);
    if (Array.isArray(fb.methods)) {
      fb.methods.forEach((m: unknown, j) =>
        method(m, `${where}.methods[${j}]`),
      );
    }
    if (fb.fbInit !== undefined) method(fb.fbInit, `${where}.fbInit`);
  });
  each("interfaces", (iface, where) => {
    if (isRecord(iface) && Array.isArray(iface.methods)) {
      iface.methods.forEach((m: unknown, j) =>
        method(m, `${where}.methods[${j}]`),
      );
    }
  });
}

/**
 * Load a library manifest from a JSON object.
 * Validates required fields and structure.
 * (In production, this would read from a .stlib.json file on disk.)
 *
 * @throws {LibraryManifestError} if required fields are missing or invalid
 */
export function loadLibraryManifest(json: unknown): LibraryManifest {
  if (json === null || json === undefined || typeof json !== "object") {
    throw new LibraryManifestError(
      "Invalid library manifest: expected a JSON object",
    );
  }

  const obj = json as Record<string, unknown>;
  validateDescriptions(obj);
  validateDefaults(obj);

  // Validate required top-level fields
  const name = obj.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'name' must be a non-empty string",
    );
  }
  const version = obj.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'version' must be a non-empty string",
    );
  }
  const namespace = obj.namespace;
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'namespace' must be a non-empty string",
    );
  }

  // Validate functions array
  const functions: LibraryManifest["functions"] = [];
  if (Array.isArray(obj.functions)) {
    for (let i = 0; i < obj.functions.length; i++) {
      const fn = obj.functions[i] as Record<string, unknown>;
      if (typeof fn.name !== "string" || fn.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].name must be a non-empty string`,
        );
      }
      if (typeof fn.returnType !== "string" || fn.returnType.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].returnType must be a non-empty string`,
        );
      }
      if (!Array.isArray(fn.parameters)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].parameters must be an array`,
        );
      }
      functions.push(fn as unknown as LibraryManifest["functions"][0]);
    }
  }

  // Validate function blocks array
  const functionBlocks: LibraryManifest["functionBlocks"] = [];
  if (Array.isArray(obj.functionBlocks)) {
    for (let i = 0; i < obj.functionBlocks.length; i++) {
      const fb = obj.functionBlocks[i] as Record<string, unknown>;
      if (typeof fb.name !== "string" || fb.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].name must be a non-empty string`,
        );
      }
      if (!Array.isArray(fb.inputs)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].inputs must be an array`,
        );
      }
      if (!Array.isArray(fb.outputs)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].outputs must be an array`,
        );
      }
      if (!Array.isArray(fb.inouts)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].inouts must be an array`,
        );
      }
      functionBlocks.push(
        fb as unknown as LibraryManifest["functionBlocks"][0],
      );
    }
  }

  // Validate types array
  const types: LibraryManifest["types"] = [];
  if (Array.isArray(obj.types)) {
    for (let i = 0; i < obj.types.length; i++) {
      const t = obj.types[i] as Record<string, unknown>;
      if (typeof t.name !== "string" || t.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].name must be a non-empty string`,
        );
      }
      if (
        typeof t.kind !== "string" ||
        !["struct", "enum", "alias"].includes(t.kind)
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].kind must be "struct", "enum", or "alias"`,
        );
      }
      if (t.fields !== undefined && !Array.isArray(t.fields)) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].fields must be an array`,
        );
      }
      if (t.members !== undefined && !Array.isArray(t.members)) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].members must be an array`,
        );
      }
      if (
        Array.isArray(t.members) &&
        t.members.some(
          (m) =>
            typeof m !== "object" ||
            m === null ||
            typeof (m as { name?: unknown }).name !== "string" ||
            (m as { name: string }).name === "",
        )
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].members must be objects with a non-empty name`,
        );
      }
      if (t.defaultValue !== undefined && typeof t.defaultValue !== "string") {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].defaultValue must be a string`,
        );
      }
      types.push(t as unknown as LibraryManifest["types"][0]);
    }
  }

  // Exported global variables (optional — archives compiled before globals
  // were exported simply omit the field).
  const globals: NonNullable<LibraryManifest["globals"]> = [];
  if (Array.isArray(obj.globals)) {
    for (let i = 0; i < obj.globals.length; i++) {
      const g = obj.globals[i] as Record<string, unknown>;
      if (typeof g.name !== "string" || g.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: globals[${i}].name must be a non-empty string`,
        );
      }
      if (typeof g.type !== "string" || g.type.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: globals[${i}].type must be a non-empty string`,
        );
      }
      globals.push(g as unknown as NonNullable<LibraryManifest["globals"]>[0]);
    }
  }

  // Exported interfaces (optional — archives built before interfaces were
  // exported omit the field).
  const interfaces: LibraryInterfaceEntry[] = [];
  if (Array.isArray(obj.interfaces)) {
    for (let i = 0; i < obj.interfaces.length; i++) {
      const iface = obj.interfaces[i] as Record<string, unknown>;
      if (typeof iface.name !== "string" || iface.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: interfaces[${i}].name must be a non-empty string`,
        );
      }
      if (!Array.isArray(iface.methods)) {
        throw new LibraryManifestError(
          `Invalid library manifest: interfaces[${i}].methods must be an array`,
        );
      }
      interfaces.push(iface as unknown as LibraryInterfaceEntry);
    }
  }

  const result: LibraryManifest = {
    name,
    version,
    namespace,
    functions,
    functionBlocks,
    types,
    headers: validateHeaders(obj.headers),
    isBuiltin: Boolean(obj.isBuiltin),
  };
  if (Array.isArray(obj.interfaces)) {
    result.interfaces = interfaces;
  }

  if (Array.isArray(obj.globals)) {
    result.globals = globals;
  }
  if (obj.description !== undefined) {
    result.description = String(obj.description);
  }
  if (Array.isArray(obj.sourceFiles)) {
    result.sourceFiles = obj.sourceFiles as string[];
  }

  return result;
}

/** A synthetic declaration of a library variable, typed as the manifest says. */
function makeVarDeclaration(v: LibraryVarType): VarDeclaration {
  return {
    kind: "VarDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    names: [v.name],
    type: makeSizedTypeRef(v),
    ...(v.edge !== undefined ? { edge: v.edge } : {}),
  };
}

function makeVarBlock(
  blockType: VarBlockType,
  vars: readonly LibraryVarType[],
  constants?: ReadonlyMap<string, Expression>,
  variables?: ReadonlySet<string>,
): VarBlock {
  return {
    kind: "VarBlock",
    sourceSpan: createDefaultSourceSpan(),
    blockType,
    isConstant: false,
    isRetain: false,
    isNonRetain: false,
    declarations: vars.map((v) => {
      const decl = makeVarDeclaration(v);
      // An input's default, which a call that omits the input passes (IEC
      // 61131-3 6.6.1.4.2), resolved in the callee's terms: the block's
      // constants it names are replaced by their values.
      if (blockType === "VAR_INPUT" && v.initialValue !== undefined) {
        const value = parseInitialValueText(v.initialValue);
        if (value !== undefined) {
          decl.initialValue = substituteConstants(value, constants);
          // One that reads a variable of the block cannot be evaluated by
          // the call: such a call must pass the input.
          let reads = false;
          walkAST(decl.initialValue, (node) => {
            if (
              node.kind === "VariableExpression" &&
              variables?.has((node as VariableExpression).name.toUpperCase())
            ) {
              reads = true;
            }
          });
          if (reads) decl.defaultNotConstant = true;
        }
      }
      return decl;
    }),
  } as VarBlock;
}

/**
 * `expr` with every plain name of `constants` replaced by its value (itself
 * resolved the same way), parenthesised so the operator precedence holds.
 */
function substituteConstants(
  expr: Expression,
  constants: ReadonlyMap<string, Expression> | undefined,
  depth = 0,
): Expression {
  if (constants === undefined || constants.size === 0 || depth > 16) {
    return expr;
  }
  const visit = (e: Expression): Expression => {
    if (
      e.kind === "VariableExpression" &&
      e.fieldAccess.length === 0 &&
      e.subscripts.length === 0 &&
      !e.isDereference
    ) {
      const value = constants.get(e.name.toUpperCase());
      if (value !== undefined) {
        return {
          kind: "ParenthesizedExpression",
          sourceSpan: e.sourceSpan,
          expression: substituteConstants(value, constants, depth + 1),
        } as Expression;
      }
      return e;
    }
    const copy = { ...e } as Record<string, unknown>;
    for (const [key, child] of Object.entries(e)) {
      if (key === "sourceSpan" || key === "parent") continue;
      if (Array.isArray(child)) {
        copy[key] = child.map((c) =>
          isExpressionNode(c)
            ? visit(c)
            : isArgument(c)
              ? { ...c, value: visit(c.value) }
              : c,
        );
      } else if (isExpressionNode(child)) {
        copy[key] = visit(child);
      }
    }
    return copy as unknown as Expression;
  };
  return visit(expr);
}

function isExpressionNode(v: unknown): v is Expression {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { kind?: unknown }).kind === "string" &&
    /Expression$/.test((v as { kind: string }).kind)
  );
}

function isArgument(v: unknown): v is { value: Expression } {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { kind?: unknown }).kind === "Argument" &&
    isExpressionNode((v as { value?: unknown }).value)
  );
}

/** Upper-case names of a library block's variables that are not constants. */
function blockVariables(fb: LibraryFBEntry): Set<string> {
  return new Set(
    [...fb.inputs, ...fb.outputs, ...fb.inouts, ...(fb.locals ?? [])]
      .filter((v) => v.readOnly !== true)
      .map((v) => v.name.toUpperCase()),
  );
}

/** A library block's constants by upper-case name: its `locals` marked `readOnly` with a value. */
function blockConstants(fb: LibraryFBEntry): Map<string, Expression> {
  const out = new Map<string, Expression>();
  for (const v of fb.locals ?? []) {
    if (v.readOnly !== true || v.initialValue === undefined) continue;
    const value = parseInitialValueText(v.initialValue);
    if (value !== undefined) out.set(v.name.toUpperCase(), value);
  }
  return out;
}

/**
 * The synthetic declaration of a library method: its prototype only, which is
 * all a consumer type-checks a call against and generates it from. The body
 * lives in the library's C++ chunk.
 */
function makeMethodDeclaration(
  m: LibraryMethodEntry,
  constants?: ReadonlyMap<string, Expression>,
  variables?: ReadonlySet<string>,
): MethodDeclaration {
  const varBlocks: VarBlock[] = [];
  if (m.inputs.length > 0) {
    varBlocks.push(makeVarBlock("VAR_INPUT", m.inputs, constants, variables));
  }
  if (m.outputs.length > 0) {
    varBlocks.push(makeVarBlock("VAR_OUTPUT", m.outputs));
  }
  if (m.inouts.length > 0) varBlocks.push(makeVarBlock("VAR_IN_OUT", m.inouts));
  return {
    kind: "MethodDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    name: m.name,
    visibility: m.visibility ?? "PUBLIC",
    isAbstract: m.isAbstract === true,
    isFinal: m.isFinal === true,
    isOverride: m.isOverride === true,
    ...(m.returnType !== undefined
      ? { returnType: makeSizedTypeRef({ name: "", ...m.returnType }) }
      : {}),
    varBlocks,
    body: [],
  };
}

/** The synthetic declaration of a library property (accessors without bodies). */
function makePropertyDeclaration(p: LibraryPropertyEntry): PropertyDeclaration {
  return {
    kind: "PropertyDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    name: p.name,
    type: makeSizedTypeRef({ name: p.name, ...p.type }),
    visibility: p.visibility ?? "PUBLIC",
    ...(p.getter === true ? { getter: [] } : {}),
    ...(p.setter === true ? { setter: [] } : {}),
  };
}

/** The synthetic declaration a library interface is known by (6.6.6). */
export function libraryInterfaceDeclaration(
  entry: LibraryInterfaceEntry,
): InterfaceDeclaration {
  return {
    kind: "InterfaceDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    name: entry.name,
    ...(entry.extends !== undefined && entry.extends.length > 0
      ? { extends: [...entry.extends] }
      : {}),
    methods: entry.methods.map((m) => makeMethodDeclaration(m)),
    properties: (entry.properties ?? []).map(makePropertyDeclaration),
  };
}

/**
 * The synthetic declaration a library function block is known by: its
 * EXTENDS / IMPLEMENTS and its PUBLIC method prototypes. Its pins are not
 * repeated here — the symbol carries them, inherited ones included.
 */
export function libraryFunctionBlockDeclaration(
  fb: LibraryFBEntry,
): FunctionBlockDeclaration {
  const cppNames: Record<string, string> = {};
  for (const v of [...fb.inputs, ...fb.outputs, ...fb.inouts]) {
    if (v.cppName !== undefined) cppNames[v.name.toUpperCase()] = v.cppName;
  }
  return {
    kind: "FunctionBlockDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    name: fb.name,
    isAbstract: fb.isAbstract === true,
    isFinal: fb.isFinal === true,
    ...(fb.extends !== undefined ? { extends: fb.extends } : {}),
    ...(fb.implements !== undefined && fb.implements.length > 0
      ? { implements: [...fb.implements] }
      : {}),
    varBlocks: [],
    methods: [
      ...(fb.methods ?? []).map((m) =>
        makeMethodDeclaration(m, blockConstants(fb), blockVariables(fb)),
      ),
      ...lifecyclePrototypes(fb),
    ],
    properties: (fb.properties ?? []).map(makePropertyDeclaration),

    body: [],
    ...(Object.keys(cppNames).length > 0 ? { libraryCppNames: cppNames } : {}),
    libraryVariables: [
      ...fb.inputs,
      ...fb.outputs,
      ...fb.inouts,
      ...(fb.locals ?? []),
    ].map((v) => v.name.toUpperCase()),
  };
}

/**
 * FB_Init / FB_Exit of a library block not already listed as PUBLIC methods,
 * as PROTECTED prototypes: the consumer builds instances with them (CODESYS
 * "Method: FB_Init") but cannot call them.
 */
function lifecyclePrototypes(fb: LibraryFBEntry): MethodDeclaration[] {
  const listed = new Set((fb.methods ?? []).map((m) => m.name.toUpperCase()));
  const out: MethodDeclaration[] = [];
  if (fb.fbInit !== undefined && !listed.has("FB_INIT")) {
    out.push({
      ...makeMethodDeclaration(fb.fbInit),
      name: "FB_INIT",
      visibility: "PROTECTED",
    });
  }
  if (fb.fbExit === true && !listed.has("FB_EXIT")) {
    out.push({
      ...makeMethodDeclaration({
        name: "FB_EXIT",
        visibility: "PROTECTED",
        returnType: { type: "BOOL" },
        inputs: [{ name: "BINCOPYCODE", type: "BOOL" }],
        outputs: [],
        inouts: [],
      }),
      visibility: "PROTECTED",
    });
  }
  return out;
}

/**
 * The interfaces and the function blocks with an OOP surface (EXTENDS,

 * IMPLEMENTS or methods) of the given libraries, as synthetic declarations.
 * A consumer compilation keeps them beside its own (CompilationUnit
 * `libraryInterfaces` / `libraryFunctionBlocks`) so the interface rules of
 * 6.6.6 — assigning an instance to an interface variable or pin, calling a
 * method — see the library's types exactly as they see the project's. They
 * are never emitted: their C++ rides in the library's chunks.
 */
export function libraryOopDeclarations(manifests: readonly LibraryManifest[]): {
  interfaces: InterfaceDeclaration[];
  functionBlocks: FunctionBlockDeclaration[];
} {
  const interfaces: InterfaceDeclaration[] = [];
  const functionBlocks: FunctionBlockDeclaration[] = [];
  const seen = new Set<string>();
  for (const manifest of manifests) {
    for (const iface of manifest.interfaces ?? []) {
      const key = iface.name.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      interfaces.push(libraryInterfaceDeclaration(iface));
    }
    for (const fb of manifest.functionBlocks) {
      const key = fb.name.toUpperCase();
      if (seen.has(key)) continue;
      // Every block: any may be a base of the unit's blocks, whose rules
      // read its variables, methods and properties.
      seen.add(key);
      functionBlocks.push(libraryFunctionBlockDeclaration(fb));
    }
  }
  return { interfaces, functionBlocks };
}

/**
 * The structures of the given libraries, members as declarations (inherited
 * ones first), for a project structure that EXTENDS one.
 */
export function libraryStructLookup(
  manifests: readonly LibraryManifest[],
): (
  name: string,
) => { fields: VarDeclaration[]; extends?: string } | undefined {
  const structs = new Map<string, LibraryTypeEntry>();
  for (const m of manifests) {
    for (const t of m.types) {
      if (t.kind === "struct") structs.set(t.name.toUpperCase(), t);
    }
  }
  return (name) => {
    const t = structs.get(name.toUpperCase());
    if (t === undefined) return undefined;
    return {
      fields: (t.fields ?? []).map(makeVarDeclaration),
      ...(t.extends !== undefined ? { extends: t.extends } : {}),
    };
  };
}

/** The library type carries this attribute pragma (case-insensitive). */
export function libraryTypeHasAttribute(
  t: LibraryTypeEntry,
  name: string,
): boolean {
  const wanted = name.toLowerCase();
  return (t.attributes ?? []).some((a) => a.name.toLowerCase() === wanted);
}

/**
 * Register a library's symbols into the compiler's symbol tables.
 * This makes library functions, FBs, and types available for semantic analysis.
 */
export function registerLibrarySymbols(
  manifest: LibraryManifest,
  symbolTables: SymbolTables,
): void {
  // An enumeration this library (or one registered before it) declares, so a
  // function returning one returns that enumeration rather than an
  // unresolved name that nothing is assignable to.
  const enumsHere = new Map(
    manifest.types
      .filter((t) => t.kind === "enum")
      .map((t) => [t.name.toUpperCase(), t]),
  );
  const libraryEnum = (name: string): EnumType | undefined => {
    const known = symbolTables.lookupType(name)?.resolvedType;
    if (known?.typeKind === "enum") return known as EnumType;
    const t = enumsHere.get(name.toUpperCase());
    if (t === undefined) return undefined;
    return {
      typeKind: "enum",
      name: t.name,
      values: (t.members ?? []).map((m) => m.name),
      ...(t.baseType !== undefined ? { baseType: t.baseType } : {}),
    } as EnumType;
  };

  // Register functions
  for (const fn of manifest.functions) {
    const unresolved: ElementaryType = {
      typeKind: "elementary",
      name: fn.returnType,
      sizeBits: 0,
    };
    const returnType: IECType =
      ELEMENTARY_TYPES[fn.returnType.toUpperCase()] ??
      libraryEnum(fn.returnType) ??
      unresolved;

    try {
      symbolTables.globalScope.define({
        name: fn.name,
        kind: "function",
        declaration: {
          kind: "FunctionDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          name: fn.name,
          returnType: {
            kind: "TypeReference",
            sourceSpan: createDefaultSourceSpan(),
            name: fn.returnType,
            isReference: false,
            referenceKind: "none",
            ...(typeof fn.returnMaxLength === "number"
              ? { maxLength: fn.returnMaxLength }
              : {}),
          },
          varBlocks: [],
          body: [],
        },
        returnType,
        parameters: fn.parameters.map((p) => {
          const { direction, ...varType } = p;
          const sym = makeVarSymbol(varType, direction);
          // Carry the optional-input marker: a parameter with an initial value
          // is optional at the call site (see Option A in the analyzer).
          if (p.initialValue !== undefined) sym.initialValue = p.initialValue;
          return sym;
        }),
      });
    } catch (e) {
      // Skip duplicate symbol errors (first definition wins), re-throw others
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // Register types
  for (const t of manifest.types) {
    // For a struct with exported fields, register a real StructType carrying its
    // member types, so member access on a dependency struct (e.g. `MATH.PI`)
    // resolves to the field's type rather than staying untyped.
    // An enum registers with its members, so a consuming compilation can
    // resolve a bare enumerator to this type. Without them the name is known
    // but nothing may be written into it.
    if (t.kind === "enum") {
      try {
        symbolTables.globalScope.define({
          name: t.name,
          kind: "type",
          declaration: {
            kind: "TypeDeclaration",
            sourceSpan: createDefaultSourceSpan(),
            name: t.name,
            ...(t.attributes !== undefined
              ? {
                  attributes: t.attributes.map((a) => ({
                    name: a.name.toLowerCase(),
                    ...(a.value !== undefined ? { value: a.value } : {}),
                    line: 0,
                    column: 0,
                  })),
                }
              : {}),
            definition: {
              kind: "EnumDefinition",
              sourceSpan: createDefaultSourceSpan(),
              members: (t.members ?? []).map((member) => {
                // The explicit value the library declared (6.4.4.3).
                const value =
                  member.value !== undefined
                    ? parseInitialValueText(member.value)
                    : undefined;
                return {
                  kind: "EnumMember" as const,
                  name: member.name,
                  ...(member.displayName !== undefined
                    ? { declaredName: member.displayName }
                    : {}),
                  sourceSpan: createDefaultSourceSpan(),
                  ...(value !== undefined ? { value } : {}),
                };
              }),
              // A data type with named values is debugged at its base's width.
              ...(t.baseType !== undefined
                ? {
                    baseType: {
                      kind: "TypeReference" as const,
                      sourceSpan: createDefaultSourceSpan(),
                      name: t.baseType,
                      isReference: false,
                      referenceKind: "none" as const,
                    },
                  }
                : {}),
            },
          },
          resolvedType: {
            typeKind: "enum",
            name: t.name,
            values: (t.members ?? []).map((m) => m.name),
            ...(t.baseType !== undefined ? { baseType: t.baseType } : {}),
            ...(libraryTypeHasAttribute(t, "strict") ? { strict: true } : {}),
          } as EnumType,
        });
        // Each member as a bare enumerated value, as a project's own
        // enumeration declares them, so `UT_STOP_FULL` is typed UT_STOP
        // wherever it appears (a generic function's argument included). A
        // qualified_only enumeration's values have no bare name.
        const bare = !libraryTypeHasAttribute(t, "qualified_only");
        (bare ? (t.members ?? []) : []).forEach((member, index) => {
          if (symbolTables.globalScope.hasLocal(member.name)) return;
          symbolTables.globalScope.define({
            name: member.name,
            kind: "enumValue",
            enumType: t.name,
            value: explicitEnumValue(member.value) ?? index,
            fromLibrary: true,
          });
        });
      } catch (e) {
        if (!(e instanceof DuplicateSymbolError)) throw e;
      }
      continue;
    }

    const resolvedType: IECType =
      t.kind === "struct" && t.fields
        ? ({
            typeKind: "struct",
            name: t.name,
            fields: new Map<string, IECType>(
              t.fields.map((f) => [
                f.name,
                ELEMENTARY_TYPES[f.type.toUpperCase()] ??
                  ({
                    typeKind: "elementary",
                    name: f.type,
                    sizeBits: 0,
                  } as ElementaryType),
              ]),
            ),
          } as StructType)
        : (ELEMENTARY_TYPES[t.name.toUpperCase()] ??
          ({
            typeKind: "elementary",
            name: t.name,
            sizeBits: 0,
          } as ElementaryType));

    try {
      symbolTables.globalScope.define({
        name: t.name,
        kind: "type",
        declaration: {
          kind: "TypeDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          name: t.name,
          declaredName: t.displayName ?? t.name,
          // A struct with exported fields gets a REAL StructDefinition, not the
          // self-referential alias the other kinds fall back to.
          //
          // Everything that walks a type reads `declaration.definition`: the
          // debug table recurses into a struct's fields through it, and an
          // alias that points at itself is what it treats as "opaque library
          // type, do not descend". That was fine while library structs were
          // only ever type-checked, and wrong the moment a RETAINed library
          // block held one — the struct's fields simply never reached the
          // retain blob, so the instance restored around a hole.
          definition: buildLibraryTypeDefinition(t),
        },
        resolvedType,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // Register interfaces as types, the way the analyzer registers a unit's own
  // (so they can name a variable's type and an IMPLEMENTS). Their prototypes
  // reach the interface rules through `libraryOopDeclarations`.
  for (const iface of manifest.interfaces ?? []) {
    try {
      symbolTables.globalScope.define({
        name: iface.name,
        kind: "type",
        declaration:
          undefined as unknown as import("../frontend/ast.js").TypeDeclaration,
        resolvedType: {
          typeKind: "elementary",
          name: iface.name,
          sizeBits: 0,
        } as ElementaryType,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // Register function blocks.
  //
  // The interface (inputs/outputs/inouts) is what a consuming compilation
  // type-checks against, and what the debugger shows: library FBs stay black
  // boxes, because their locals are implementation details.
  //
  // `locals` is the exception, and only retain uses it. It carries the block's
  // own VAR members so a RETAINed instance keeps the state it actually runs
  // on; it does not widen what the debugger displays, which stays the
  // interface.
  for (const fb of manifest.functionBlocks) {
    try {
      symbolTables.globalScope.define({
        name: fb.name,
        kind: "functionBlock",
        declaration: libraryFunctionBlockDeclaration(fb),
        inputs: fb.inputs.map((i) => makeVarSymbol(i, "input")),
        outputs: fb.outputs.map((o) => makeVarSymbol(o, "output")),
        inouts: fb.inouts.map((io) => makeVarSymbol(io, "inout")),
        // Present from archives that export them; an older archive leaves
        // this empty and a RETAINed instance of its blocks covers the visible
        // surface only, with a warning naming the block.
        locals: (fb.locals ?? []).map((l) => makeVarSymbol(l, "local")),
        libraryName: manifest.name,
        ...(fb.inoutsByReference === true ? { inoutsByReference: true } : {}),
        ...(fb.extends !== undefined ? { libraryExtends: fb.extends } : {}),
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // Register exported global variables into the shared global scope. Because
  // every imported library registers into the SAME globalScope (and duplicates
  // are skipped, first-wins), a program importing several libraries can see all
  // of their globals together at the same place — globals are additive.
  for (const g of manifest.globals ?? []) {
    // A global of a declared type (an enumeration, a struct the library or
    // one it depends on exports) takes that type, registered above: a
    // placeholder made it a distinct type, so passing the global to the
    // library's own function of that type was refused.
    const varType: IECType = ELEMENTARY_TYPES[g.type.toUpperCase()] ??
      symbolTables.lookupType(g.type)?.resolvedType ??
      ({ typeKind: "elementary", name: g.type, sizeBits: 0 } as ElementaryType);
    try {
      symbolTables.globalScope.define({
        name: g.name,
        kind: "variable",
        type: varType,
        declaration: {
          kind: "VarDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          names: [g.name],
          type: {
            kind: "TypeReference",
            sourceSpan: createDefaultSourceSpan(),
            name: g.type,
            isReference: false,
            referenceKind: "none",
          },
        },
        isInput: false,
        isOutput: false,
        isInOut: false,
        isExternal: false,
        isGlobal: true,
        isRetain: false,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }
}

/**
 * Load a `.stlib` archive from a parsed JSON object.
 * Validates the archive structure including formatVersion, manifest, headerCode,
 * cppCode, and dependencies.
 *
 * @throws {LibraryManifestError} if required fields are missing or invalid
 */
export function loadStlibArchive(json: unknown): StlibArchive {
  if (json === null || json === undefined || typeof json !== "object") {
    throw new LibraryManifestError(
      "Invalid stlib archive: expected a JSON object",
    );
  }

  const obj = json as Record<string, unknown>;

  // Validate formatVersion
  if (obj.formatVersion !== 1) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'formatVersion' must be 1",
    );
  }

  // Validate manifest
  if (
    obj.manifest === null ||
    obj.manifest === undefined ||
    typeof obj.manifest !== "object"
  ) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'manifest' must be an object",
    );
  }
  const manifest = loadLibraryManifest(obj.manifest);

  // Validate chunks — every per-symbol slice of the library's emitted
  // C++ output, plus its dep edges. Empty array is valid (synthetic
  // libraries like iec-std-functions ship only symbol-table entries).
  if (!Array.isArray(obj.chunks)) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'chunks' must be an array",
    );
  }

  // Validate dependencies
  if (!Array.isArray(obj.dependencies)) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'dependencies' must be an array",
    );
  }

  const archive: StlibArchive = {
    formatVersion: 1,
    manifest,
    chunks: obj.chunks as StlibArchive["chunks"],
    dependencies: obj.dependencies as Array<{ name: string; version: string }>,
  };

  // The calling convention it was built for; absent in an older archive.
  if (typeof obj.abiVersion === "number") {
    archive.abiVersion = obj.abiVersion;
  }

  // Optional sources
  if (Array.isArray(obj.sources)) {
    archive.sources = obj.sources as Array<{
      fileName: string;
      source: string;
    }>;
  }

  // Optional globalConstants
  if (
    obj.globalConstants !== null &&
    obj.globalConstants !== undefined &&
    typeof obj.globalConstants === "object" &&
    !Array.isArray(obj.globalConstants)
  ) {
    const gc: Record<string, number> = {};
    for (const [key, val] of Object.entries(
      obj.globalConstants as Record<string, unknown>,
    )) {
      if (typeof val !== "number") {
        throw new LibraryManifestError(
          `Invalid stlib archive: globalConstants["${key}"] must be a number, got ${typeof val}`,
        );
      }
      gc[key] = val;
    }
    archive.globalConstants = gc;
  }

  return archive;
}

/**
 * Parse and validate an stlib archive from its raw JSON text.
 *
 * Browser-safe sibling of `loadStlibFromFile` — takes a string the
 * caller already obtained (HTTP fetch, IPC, FileReader, etc.) instead
 * of touching the filesystem.  Use this in environments without `fs`.
 *
 * @param raw - JSON text of the `.stlib` archive
 * @param sourceLabel - Optional label used in error messages
 * @returns The validated archive
 * @throws {LibraryManifestError} if the JSON is malformed or invalid
 */
export function loadStlibFromString(
  raw: string,
  sourceLabel: string = "<string>",
): StlibArchive {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new LibraryManifestError(
      `Invalid JSON in stlib archive: ${sourceLabel}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return loadStlibArchive(json);
}

/**
 * Parse and validate an stlib archive from raw bytes.
 *
 * Browser-safe sibling of `loadStlibFromFile` — accepts the byte
 * payload of an `.stlib` (UTF-8 encoded JSON).  Suitable for
 * `fetch(...).then(r => r.arrayBuffer())` flows and for Electron
 * preload paths that hand the renderer a `Uint8Array` over IPC.
 *
 * @param bytes - Raw UTF-8 bytes of the `.stlib` archive
 * @param sourceLabel - Optional label used in error messages
 * @returns The validated archive
 * @throws {LibraryManifestError} if the JSON is malformed or invalid
 */
export function loadStlibFromBuffer(
  bytes: Uint8Array,
  sourceLabel: string = "<buffer>",
): StlibArchive {
  // TextDecoder is available in modern Node (≥11) and every browser /
  // worker context we care about.  Avoids pulling in `Buffer` so the
  // browser bundler doesn't have to polyfill it.
  const raw = new TextDecoder("utf-8").decode(bytes);
  return loadStlibFromString(raw, sourceLabel);
}

// File-shaped wrappers (`loadStlibFromFile`, `discoverStlibs`,
// `loadLibraryFromFile`, `discoverLibraries`) live in
// `src/node/library-loader.ts`.  Browser / worker consumers fetch
// bytes themselves and call the pure `loadStlibFromString` /
// `loadStlibFromBuffer` / `loadStlibArchive` / `loadLibraryManifest`
// helpers above.

/** An enumerator's explicit value when it is an integer literal. */
function explicitEnumValue(
  text: string | null | undefined,
): number | undefined {
  if (typeof text !== "string") return undefined;
  const n = Number(text.replace(/_/g, ""));
  return Number.isInteger(n) ? n : undefined;
}

/**
 * The defaults of the libraries' enumerated types, for a consumer's
 * declarations of them (`applyTypeDefaults`): the type's own initial value,
 * else its first member when that has an explicit value (IEC 61131-3
 * 6.4.4.2.2, 6.4.4.3.2). Qualified (`E#A`), since a library's member names
 * need not be unique.
 */
export function libraryTypeDefaults(
  manifests: readonly LibraryManifest[],
): Map<string, Expression> {
  const out = new Map<string, Expression>();
  for (const manifest of manifests) {
    for (const t of manifest.types) {
      if (t.kind !== "enum") continue;
      const span = createDefaultSourceSpan();
      const key = t.name.toUpperCase();
      if (t.defaultValue !== undefined) {
        const hash = t.defaultValue.indexOf("#");
        const member =
          hash >= 0 ? t.defaultValue.slice(hash + 1) : t.defaultValue;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) {
          out.set(key, qualifiedEnumValue(t.name, member.toUpperCase(), span));
        } else {
          // A data type with named values may start from any value (6.4.4.3.2).
          const value = parseInitialValueText(t.defaultValue);
          if (value !== undefined) out.set(key, value);
        }
      } else if (t.members?.[0]?.value !== undefined) {
        out.set(key, qualifiedEnumValue(t.name, t.members[0].name, span));
      }
    }
  }
  return out;
}
