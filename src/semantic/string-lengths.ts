/**
 * Declared lengths of STRING(n) / WSTRING(n).
 *
 * IEC 61131-3:2013 6.4.2.2 (p. 32): a declared length "shall not exceed" the
 * maximum the programming and debugging tool supports; Table 10, footnote k:
 * that maximum is Implementer specific. STruC++ supports 1 to 65535 code units
 * (the string types keep their length in a uint16_t). A length outside that
 * range is a compile error.
 *
 * A length given as a constant's name (`STRING(LEN)`) is resolved to its value
 * in place, before the project model copies the declarations: the C++ types,
 * the debug and retain tables and the type descriptors all need the number.
 */

import type {
  ASTNode,
  CompilationUnit,
  Expression,
  TypeReference,
  VarBlock,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";

/** The longest STRING / WSTRING STruC++ supports, in code units. */
export const MAX_STRING_LENGTH = 65535;

/** One set of declarations and the constants it sees. */
export interface ConstantScope {
  /** The declarations this scope folds (a method: its own, not its block's). */
  own: VarBlock[];
  /** Where its declared types are. */
  roots: ASTNode[];
  /** Upper-cased constant names to their initial values. */
  constants: Map<string, Expression>;
  /** Global variables (not CONSTANT) it names through VAR_EXTERNAL. */
  externalVariables: Set<string>;
}

/**
 * The constants each set of declarations sees: the top-level and
 * CONFIGURATION VAR_GLOBAL CONSTANTs everywhere a declaration does not hide
 * them, a VAR_EXTERNAL naming one, and the POU's own VAR CONSTANT. A method
 * sees its block's declarations as well as its own.
 */
export function constantScopes(ast: CompilationUnit): {
  globalConstants: Map<string, Expression>;
  globalBlocks: VarBlock[];
  pous: ConstantScope[];
} {
  const globalConstants = new Map<string, Expression>();
  const globalVariables = new Set<string>();
  const collect = (blocks: VarBlock[], into: Map<string, Expression>): void => {
    for (const block of blocks) {
      if (block.blockType !== "VAR_GLOBAL") continue;
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          if (block.isConstant && decl.initialValue !== undefined) {
            into.set(name.toUpperCase(), decl.initialValue);
          } else {
            globalVariables.add(name.toUpperCase());
          }
        }
      }
    }
  };
  collect(ast.globalVarBlocks, globalConstants);
  for (const config of ast.configurations) {
    collect(config.varBlocks, globalConstants);
  }
  const globalBlocks = [
    ...ast.globalVarBlocks,
    ...ast.configurations.flatMap((c) => c.varBlocks),
  ];

  const pous: Array<{ blocks: VarBlock[]; own: VarBlock[]; roots: ASTNode[] }> =
    [
      ...ast.programs.map((p) => ({
        blocks: p.varBlocks,
        own: p.varBlocks,
        roots: [...p.varBlocks],
      })),
      ...ast.functions.map((f) => ({
        blocks: f.varBlocks,
        own: f.varBlocks,
        roots: [f.returnType, ...f.varBlocks],
      })),
      ...ast.functionBlocks.flatMap((fb) => [
        {
          blocks: fb.varBlocks,
          own: fb.varBlocks,
          roots: [...fb.varBlocks, ...fb.properties.map((p) => p.type)],
        },
        ...fb.methods.map((m) => ({
          blocks: [...fb.varBlocks, ...m.varBlocks],
          own: m.varBlocks,
          roots: [...(m.returnType ? [m.returnType] : []), ...m.varBlocks],
        })),
      ]),
    ];
  const scopes: ConstantScope[] = [];
  for (const { blocks, own, roots } of pous) {
    const constants = new Map<string, Expression>();
    const externalVariables = new Set<string>();
    // Top-level constants are visible unless a declaration here hides them.
    const declared = new Set(
      blocks.flatMap((b) =>
        b.declarations.flatMap((d) => d.names.map((n) => n.toUpperCase())),
      ),
    );
    for (const [name, value] of globalConstants) {
      if (!declared.has(name)) constants.set(name, value);
    }
    for (const block of blocks) {
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          const upper = name.toUpperCase();
          if (block.blockType === "VAR_EXTERNAL") {
            const value = globalConstants.get(upper);
            if (value !== undefined) constants.set(upper, value);
            else if (globalVariables.has(upper)) externalVariables.add(upper);
          } else if (block.isConstant && decl.initialValue !== undefined) {
            constants.set(upper, decl.initialValue);
          }
        }
      }
    }
    scopes.push({ own, roots, constants, externalVariables });
  }
  return { globalConstants, globalBlocks, pous: scopes };
}

/** Constants by upper-cased name: a declaration's value, or a number given to the compiler. */
export type ConstantValues = ReadonlyMap<string, Expression | number>;

/**
 * A compile-time integer: literals, the constants in `constants` (followed
 * through each other), unary -, + - * / MOD and parentheses.
 */
export function evalConstantInteger(
  e: Expression | number | undefined,
  constants: ConstantValues = new Map(),
  seen: ReadonlySet<string> = new Set(),
): number | undefined {
  if (e === undefined) return undefined;
  if (typeof e === "number") return Number.isInteger(e) ? e : undefined;
  const sub = (x: Expression): number | undefined =>
    evalConstantInteger(x, constants, seen);
  switch (e.kind) {
    case "LiteralExpression": {
      const v: unknown = e.value;
      if (typeof v === "number" && Number.isInteger(v)) return v;
      if (typeof v === "bigint") {
        const n = Number(v);
        return Number.isSafeInteger(n) ? n : undefined;
      }
      return undefined;
    }
    case "VariableExpression": {
      const upper = e.name.toUpperCase();
      const plain =
        e.subscripts.length === 0 &&
        e.fieldAccess.length === 0 &&
        !e.isDereference;
      if (!plain || seen.has(upper)) return undefined;
      return evalConstantInteger(
        constants.get(upper),
        constants,
        new Set([...seen, upper]),
      );
    }
    case "ParenthesizedExpression":
      return sub(e.expression);
    case "UnaryExpression": {
      const v = sub(e.operand);
      if (v === undefined) return undefined;
      if (e.operator === "-") return -v;
      return undefined;
    }
    case "BinaryExpression": {
      const l = sub(e.left);
      const r = sub(e.right);
      if (l === undefined || r === undefined) return undefined;
      switch (e.operator) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return r === 0 ? undefined : Math.trunc(l / r);
        case "MOD":
          return r === 0 ? undefined : l % r;
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

function isStringType(name: string | undefined): boolean {
  const upper = name?.toUpperCase();
  return upper === "STRING" || upper === "WSTRING";
}

function outOfRange(n: number): boolean {
  return !Number.isInteger(n) || n < 1 || n > MAX_STRING_LENGTH;
}

const RANGE = `a declared length must be 1 to ${MAX_STRING_LENGTH} (IEC 61131-3 6.4.2.2)`;

/**
 * Resolve and check every declared STRING / WSTRING length under `roots`. A
 * named length that is not a constant of `constants` is left as it is. Each
 * length outside 1..65535 is reported once through `error`.
 */
export function resolveStringLengths(
  roots: readonly ASTNode[],
  constants: ConstantValues,
  error: (message: string, at: ASTNode) => void,
): void {
  for (const root of roots) {
    walkAST(root, (node) => {
      if (node.kind !== "TypeReference") return;
      const ref = node as TypeReference;
      if (isStringType(ref.name) && ref.maxLength !== undefined) {
        const declared = ref.maxLength;
        if (typeof declared === "string") {
          const upper = declared.toUpperCase();
          const value = evalConstantInteger(
            constants.get(upper),
            constants,
            new Set([upper]),
          );
          if (value !== undefined && outOfRange(value)) {
            error(
              `${ref.name.toUpperCase()}(${declared}) has length ${value}: ${RANGE}`,
              ref,
            );
          } else if (value !== undefined) {
            ref.maxLength = value;
          }
        } else if (outOfRange(declared)) {
          error(`${ref.name.toUpperCase()}(${declared}): ${RANGE}`, ref);
        }
      }
      if (
        ref.elementTypeName !== undefined &&
        isStringType(ref.elementTypeName) &&
        ref.elementMaxLength !== undefined &&
        outOfRange(ref.elementMaxLength)
      ) {
        error(
          `${ref.elementTypeName.toUpperCase()}(${ref.elementMaxLength}): ${RANGE}`,
          ref,
        );
      }
    });
  }
}

/**
 * Every declared STRING / WSTRING length in the program: named ones resolved
 * to their values, each one checked against 1..65535. `predefined` are the
 * constants given to the compiler (`globalConstants`: `-D`, a library's), seen
 * wherever the program declares no constant of that name.
 */
export function resolveDeclaredStringLengths(
  ast: CompilationUnit,
  error: (message: string, at: ASTNode) => void,
  predefined: Readonly<Record<string, number>> = {},
): void {
  const scopes = constantScopes(ast);
  const withPredefined = (
    constants: ReadonlyMap<string, Expression>,
  ): ConstantValues => {
    const all = new Map<string, Expression | number>();
    for (const [name, value] of Object.entries(predefined)) {
      all.set(name.toUpperCase(), value);
    }
    for (const [name, value] of constants) all.set(name, value);
    return all;
  };
  resolveStringLengths(
    [...ast.types, ...ast.interfaces, ...scopes.globalBlocks],
    withPredefined(scopes.globalConstants),
    error,
  );
  for (const { roots, constants } of scopes.pous) {
    resolveStringLengths(roots, withPredefined(constants), error);
  }
}
