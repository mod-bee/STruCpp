// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * The CODESYS lifecycle methods of a function block (CODESYS online help,
 * "Method: FB_Init, FB_Reinit, FB_Exit"):
 *
 * - `FB_Init` runs once for every instance, after the implicit initialization
 *   of its variables and before the instance's initial assignments. Its first
 *   two inputs are `bInitRetains` and `bInCopyCode`; further inputs are set
 *   where the instance is declared (`com1 : serialdevice(iCOMnum := 1);`).
 *   A derived block's FB_Init repeats its base's parameters and may add more;
 *   each block's FB_Init is called, the base first. It must not call
 *   `SUPER^.FB_Init`.
 * - `FB_Exit` (one input, `bInCopyCode`) runs before an instance is removed,
 *   the derived block first.
 * - `FB_Reinit` takes no input and is only called by the application here:
 *   it is the online-change hook, and this runtime has no online change.
 *
 * IEC 61131-3 has none of the three; a method named so is an ordinary method
 * there, which is why these rules apply only to these three names.
 */

import type {
  Argument,
  CompilationUnit,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  MethodDeclaration,
  VarBlock,
  VarDeclaration,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import type { SourceSpan } from "../types.js";

export const FB_INIT = "FB_INIT";
export const FB_EXIT = "FB_EXIT";
export const FB_REINIT = "FB_REINIT";

/** Number of the FB_Init inputs the system sets (bInitRetains, bInCopyCode). */
export const FB_INIT_SYSTEM_INPUTS = 2;

export interface FbLifecycleError {
  message: string;
  span: SourceSpan;
}

/** An input of a method, flattened: one entry per declared name. */
export interface MethodInput {
  name: string;
  decl: VarDeclaration;
}

/** Every function block known to the unit: its own, then the libraries'. */
function blockLookup(
  ast: CompilationUnit,
): (name: string | undefined) => FunctionBlockDeclaration | undefined {
  const map = new Map<string, FunctionBlockDeclaration>();
  for (const fb of ast.libraryFunctionBlocks ?? [])
    map.set(fb.name.toUpperCase(), fb);
  for (const fb of ast.functionBlocks) map.set(fb.name.toUpperCase(), fb);
  return (name) =>
    name === undefined ? undefined : map.get(name.toUpperCase());
}

/** The block and the blocks it EXTENDS, nearest first (cycle-safe). */
export function fbLineage(
  ast: CompilationUnit,
  typeName: string,
): FunctionBlockDeclaration[] {
  const lookup = blockLookup(ast);
  const out: FunctionBlockDeclaration[] = [];
  const seen = new Set<string>();
  let fb = lookup(typeName);
  while (fb !== undefined && !seen.has(fb.name.toUpperCase())) {
    seen.add(fb.name.toUpperCase());
    out.push(fb);
    fb = lookup(fb.extends);
  }
  return out;
}

/** The block's own method of this name, if it declares one. */
export function ownMethod(
  fb: FunctionBlockDeclaration,
  upperName: string,
): MethodDeclaration | undefined {
  return fb.methods.find((m) => m.name.toUpperCase() === upperName);
}

/**
 * The FB_Init (or FB_Exit) a block runs: its own, else the nearest base's.
 * Undefined when neither the block nor a base declares one.
 */
export function effectiveLifecycleMethod(
  ast: CompilationUnit,
  typeName: string,
  upperName: typeof FB_INIT | typeof FB_EXIT,
): MethodDeclaration | undefined {
  for (const fb of fbLineage(ast, typeName)) {
    const m = ownMethod(fb, upperName);
    if (m !== undefined) return m;
  }
  return undefined;
}

/** A method's VAR_INPUT names in declaration order. */
export function methodInputs(method: MethodDeclaration): MethodInput[] {
  return method.varBlocks
    .filter((b) => b.blockType === "VAR_INPUT")
    .flatMap((b) =>
      b.declarations.flatMap((decl) =>
        decl.names.map((name) => ({ name: name.toUpperCase(), decl })),
      ),
    );
}

/** The FB_Init inputs set at an instance's declaration (after the first two). */
export function fbInitUserInputs(method: MethodDeclaration): MethodInput[] {
  return methodInputs(method).slice(FB_INIT_SYSTEM_INPUTS);
}

function sectionCount(method: MethodDeclaration, type: VarBlock["blockType"]) {
  return method.varBlocks
    .filter((b) => b.blockType === type)
    .reduce(
      (n, b) => n + b.declarations.reduce((k, d) => k + d.names.length, 0),
      0,
    );
}

function isBool(decl: VarDeclaration): boolean {
  return (
    decl.type.name.toUpperCase() === "BOOL" &&
    decl.type.referenceKind === "none" &&
    decl.type.arrayDimensions === undefined
  );
}

function returnsBool(method: MethodDeclaration): boolean {
  return method.returnType?.name.toUpperCase() === "BOOL";
}

function sameInputType(a: VarDeclaration, b: VarDeclaration): boolean {
  return (
    a.type.name.toUpperCase() === b.type.name.toUpperCase() &&
    a.type.referenceKind === b.type.referenceKind &&
    JSON.stringify(a.type.arrayDimensions ?? null) ===
      JSON.stringify(b.type.arrayDimensions ?? null)
  );
}

/** The signature rules of the three methods, for one block. */
function checkSignatures(
  fb: FunctionBlockDeclaration,
  ast: CompilationUnit,
  errors: FbLifecycleError[],
): void {
  const at = (m: MethodDeclaration, message: string): void => {
    errors.push({ message, span: m.sourceSpan });
  };
  for (const m of fb.methods) {
    const upper = m.name.toUpperCase();
    if (upper !== FB_INIT && upper !== FB_EXIT && upper !== FB_REINIT) continue;
    const shown =
      upper === FB_INIT
        ? "FB_Init"
        : upper === FB_EXIT
          ? "FB_Exit"
          : "FB_Reinit";
    if (!returnsBool(m)) {
      at(
        m,
        `${shown} of '${fb.name}' must return BOOL (CODESYS "Method: FB_Init, FB_Reinit, FB_Exit")`,
      );
    }
    if (m.isAbstract) {
      at(
        m,
        `${shown} of '${fb.name}' cannot be ABSTRACT: the system calls it on every instance`,
      );
    }
    if (
      sectionCount(m, "VAR_OUTPUT") > 0 ||
      sectionCount(m, "VAR_IN_OUT") > 0
    ) {
      at(
        m,
        `${shown} of '${fb.name}' takes inputs only (no VAR_OUTPUT or VAR_IN_OUT)`,
      );
    }
    const inputs = methodInputs(m);
    if (upper === FB_INIT) {
      if (
        inputs.length < FB_INIT_SYSTEM_INPUTS ||
        !inputs.slice(0, 2).every((i) => isBool(i.decl))
      ) {
        at(
          m,
          `FB_Init of '${fb.name}' starts with the inputs bInitRetains : BOOL and bInCopyCode : BOOL`,
        );
      }
    } else if (upper === FB_EXIT) {
      if (inputs.length !== 1 || !isBool(inputs[0]!.decl)) {
        at(
          m,
          `FB_Exit of '${fb.name}' has exactly one input, bInCopyCode : BOOL`,
        );
      }
    } else if (inputs.length !== 0) {
      at(m, `FB_Reinit of '${fb.name}' takes no inputs`);
    }
  }

  // A derived FB_Init repeats its base's parameters, then may add its own.
  const own = ownMethod(fb, FB_INIT);
  if (own !== undefined && fb.extends !== undefined) {
    const base = effectiveLifecycleMethod(ast, fb.extends, FB_INIT);
    if (base !== undefined) {
      const mine = methodInputs(own);
      const theirs = methodInputs(base);
      const matches =
        mine.length >= theirs.length &&
        theirs.every(
          (t, i) =>
            mine[i]!.name === t.name && sameInputType(mine[i]!.decl, t.decl),
        );
      if (!matches) {
        at(
          own,
          `FB_Init of '${fb.name}' must declare the same inputs as the FB_Init of its base '${fb.extends}' (${theirs.map((t) => t.name).join(", ")}), in that order, before any of its own`,
        );
      }
    }
  }
  for (const m of fb.methods) {
    walkAST(m, (node) => {
      if (node.kind !== "FunctionCallExpression") return;
      const call = node as FunctionCallExpression;
      if (call.functionName.toUpperCase() === `SUPER.${FB_INIT}`) {
        errors.push({
          message:
            "SUPER^.FB_Init must not be called: the base's FB_Init has already run when this one runs",
          span: call.sourceSpan,
        });
      }
    });
  }
}

/** Every variable section of the unit with the declarations in it. */
function allVarBlocks(ast: CompilationUnit): VarBlock[] {
  const out: VarBlock[] = [...ast.globalVarBlocks];
  for (const p of ast.programs) out.push(...p.varBlocks);
  for (const f of ast.functions) out.push(...f.varBlocks);
  for (const fb of ast.functionBlocks) {
    out.push(...fb.varBlocks);
    for (const m of fb.methods) out.push(...m.varBlocks);
  }
  for (const c of ast.configurations) {
    out.push(...c.varBlocks);
  }

  return out;
}

function checkInitArguments(
  ast: CompilationUnit,
  block: VarBlock,
  decl: VarDeclaration,
  errors: FbLifecycleError[],
): void {
  const args = decl.initArguments;
  if (args === undefined) return;
  const name = decl.names[0] ?? "";
  const fail = (message: string, span: SourceSpan = decl.sourceSpan): void => {
    errors.push({ message, span });
  };
  const isFb = fbLineage(ast, decl.type.name).length > 0;
  if (!isFb || decl.type.referenceKind !== "none") {
    fail(
      `'${name}': arguments after a type set the FB_Init inputs of a function block instance; '${decl.type.name}' is not a function block`,
    );
    return;
  }
  if (decl.type.arrayDimensions !== undefined) {
    fail(
      `'${name}': FB_Init arguments on an array of instances are not supported`,
    );
    return;
  }
  if (block.blockType === "VAR_IN_OUT" || block.blockType === "VAR_EXTERNAL") {
    fail(
      `'${name}': a ${block.blockType} refers to an instance declared elsewhere; its FB_Init arguments belong there`,
    );
    return;
  }
  const init = effectiveLifecycleMethod(ast, decl.type.name, FB_INIT);
  const inputs = init ? fbInitUserInputs(init) : [];
  if (args.length > 0 && inputs.length === 0) {
    fail(`'${name}': '${decl.type.name}' has no FB_Init input to set`);
    return;
  }
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg.name === undefined || arg.isOutput) {
      fail(
        `'${name}': FB_Init arguments are named, as in \`${name} : ${decl.type.name}(${inputs[0]?.name ?? "input"} := value)\``,
        arg.sourceSpan,
      );
      continue;
    }
    const upper = arg.name.toUpperCase();
    if (!inputs.some((i) => i.name === upper)) {
      fail(
        `'${name}': '${arg.name}' is not an FB_Init input of '${decl.type.name}' (${inputs.map((i) => i.name).join(", ")})`,
        arg.sourceSpan,
      );
      continue;
    }
    if (seen.has(upper)) {
      fail(
        `'${name}': FB_Init input '${arg.name}' is set twice`,
        arg.sourceSpan,
      );
    }
    seen.add(upper);
  }
}

/**
 * The FB_Init arguments of a declaration, in the order of the FB_Init inputs
 * after the first two; an input not set takes its initial value (undefined).
 */
export function orderedInitArguments(
  init: MethodDeclaration,
  args: readonly Argument[],
): { input: MethodInput; arg: Argument | undefined }[] {
  return fbInitUserInputs(init).map((input) => ({
    input,
    arg: args.find((a) => a.name?.toUpperCase() === input.name),
  }));
}

/** True when the block or a block it EXTENDS declares FB_Init or FB_Exit. */
export function isLifecycleBlock(
  ast: CompilationUnit,
  typeName: string,
): boolean {
  return fbLineage(ast, typeName).some(
    (fb) =>
      ownMethod(fb, FB_INIT) !== undefined ||
      ownMethod(fb, FB_EXIT) !== undefined,
  );
}

/**
 * An array of instances with FB_Init / FB_Exit is initialized element by
 * element in place; an initial value for its elements would be built from
 * temporaries, which run FB_Init and FB_Exit of their own.
 */
function checkArrayInitialValue(
  ast: CompilationUnit,
  decl: VarDeclaration,
  errors: FbLifecycleError[],
): void {
  const element = decl.type.elementTypeName;
  if (
    decl.initialValue === undefined ||
    decl.type.arrayDimensions === undefined ||
    element === undefined ||
    !isLifecycleBlock(ast, element)
  ) {
    return;
  }
  errors.push({
    message: `'${decl.names[0] ?? ""}': an initial value for an array of '${element}' instances is not supported ('${element}' has FB_Init or FB_Exit); set the elements in the body`,
    span: decl.initialValue.sourceSpan,
  });
}

/** All lifecycle rules of the unit. */

export function checkFbLifecycleRules(
  ast: CompilationUnit,
): FbLifecycleError[] {
  const errors: FbLifecycleError[] = [];
  for (const fb of ast.functionBlocks) checkSignatures(fb, ast, errors);
  for (const block of allVarBlocks(ast)) {
    for (const decl of block.declarations) {
      checkInitArguments(ast, block, decl, errors);
      checkArrayInitialValue(ast, decl, errors);
    }
  }
  return errors;
}
