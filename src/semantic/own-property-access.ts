// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A block's own property named bare inside the block: `y := P;` and `P := v;`
 * in its body, its methods and its other properties' accessors. CODESYS reads
 * and writes it as `THIS^.P` (online help, "Object: Property"); IEC 61131-3
 * Ed.3 has no properties. The reference is rewritten to that form here, so the
 * checks and the code generation treat both spellings alike.
 */

import type {
  ASTNode,
  CompilationUnit,
  FunctionBlockDeclaration,
  Statement,
  VarBlock,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import { findFunctionBlock } from "./interface-utils.js";

function varNames(blocks: VarBlock[], into: Set<string>): void {
  for (const block of blocks) {
    for (const decl of block.declarations) {
      for (const name of decl.names) into.add(name.toUpperCase());
    }
  }
}

/** The block and its EXTENDS chain, the block first. */
function chainOf(
  ast: CompilationUnit,
  fb: FunctionBlockDeclaration,
): FunctionBlockDeclaration[] {
  const chain: FunctionBlockDeclaration[] = [];
  const seen = new Set<string>();
  let current: FunctionBlockDeclaration | undefined = fb;
  while (current && !seen.has(current.name.toUpperCase())) {
    seen.add(current.name.toUpperCase());
    chain.push(current);
    current =
      current.extends !== undefined
        ? findFunctionBlock(ast, current.extends)
        : undefined;
  }
  return chain;
}

function rewrite(
  roots: Statement[],
  properties: Set<string>,
  shadowed: Set<string>,
): void {
  for (const root of roots) {
    walkAST(root as ASTNode, (node) => {
      if (node.kind !== "VariableExpression") return;
      const v = node as VariableExpression;
      const upper = v.name.toUpperCase();
      if (
        !properties.has(upper) ||
        shadowed.has(upper) ||
        v.isDereference ||
        v.subscripts.length > 0 ||
        v.fieldAccess.length > 0 ||
        (v.accessChain !== undefined && v.accessChain.length > 0)
      ) {
        return;
      }
      v.fieldAccess = [v.name];
      v.name = "THIS";
    });
  }
}

export function bindOwnPropertyAccess(ast: CompilationUnit): void {
  for (const fb of ast.functionBlocks) {
    const chain = chainOf(ast, fb);
    const properties = new Set<string>();
    const members = new Set<string>();
    for (const block of chain) {
      for (const p of block.properties) properties.add(p.name.toUpperCase());
      varNames(block.varBlocks, members);
      for (const name of block.libraryVariables ?? []) members.add(name);
    }
    if (properties.size === 0) continue;

    rewrite(fb.body, properties, members);
    for (const method of fb.methods) {
      const shadowed = new Set(members);
      varNames(method.varBlocks, shadowed);
      shadowed.add(method.name.toUpperCase());
      rewrite(method.body, properties, shadowed);
    }
    for (const prop of fb.properties) {
      const shadowed = new Set(members);
      shadowed.add(prop.name.toUpperCase());
      rewrite(prop.getter ?? [], properties, shadowed);
      rewrite(prop.setter ?? [], properties, shadowed);
    }
  }
}
