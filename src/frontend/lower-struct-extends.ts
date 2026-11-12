// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * STRUCT EXTENDS (CODESYS online help, "Data Structure: STRUCT", extension of
 * a type declaration: "In addition to its own members, the extended
 * structure also has the same structure members as the base structure"):
 *
 *   TYPE S_PENTAGON EXTENDS S_POLYGONLINE : STRUCT aiPoint5 : ... END_STRUCT
 *
 * Lowered once, after parsing: the base's members (its own base's first) are
 * copied in front of the derived structure's own, each marked
 * `inheritedFrom`, so everything that walks a structure's members (types,
 * initializers, the debug table, layout tables, the library manifest) sees
 * each member once. The C++ structure derives from the base's, which holds
 * the inherited members and their initial values.
 */

import type {
  CompilationUnit,
  StructDefinition,
  TypeDeclaration,
  VarDeclaration,
} from "./ast.js";
import type { CompileError } from "../types.js";

/** A library structure a project structure may extend. */
export interface ExternalStruct {
  fields: VarDeclaration[];
  extends?: string;
}

/**
 * Copy each base's members into the structures that EXTEND it. Errors: a
 * base that is not a structure, a cycle, a member repeating a base's name,
 * EXTENDS on a type that is not a structure.
 */
export function lowerStructExtends(
  unit: CompilationUnit,
  external: (name: string) => ExternalStruct | undefined = () => undefined,
): CompileError[] {
  const errors: CompileError[] = [];
  const byName = new Map<string, TypeDeclaration>();
  for (const td of unit.types) byName.set(td.name.toUpperCase(), td);
  const fail = (td: TypeDeclaration, message: string): void => {
    errors.push({
      message,
      line: td.sourceSpan.startLine,
      column: td.sourceSpan.startCol,
      severity: "error",
      ...(td.sourceSpan.file ? { file: td.sourceSpan.file } : {}),
    });
  };
  const done = new Set<string>();
  const visiting = new Set<string>();
  /** Structures on an EXTENDS cycle: reported once, left as declared. */
  const cyclic = new Set<string>();

  /** The full member list of `name` (inherited first), or undefined. */
  const membersOf = (name: string): VarDeclaration[] | undefined => {
    const td = byName.get(name.toUpperCase());
    if (td === undefined) return external(name)?.fields;
    if (td.definition.kind !== "StructDefinition") return undefined;
    lower(td);
    return cyclic.has(name.toUpperCase()) ? undefined : td.definition.fields;
  };

  const lower = (td: TypeDeclaration): void => {
    const key = td.name.toUpperCase();
    if (done.has(key) || td.extends === undefined) return;
    if (td.definition.kind !== "StructDefinition") {
      fail(td, `TYPE '${td.name}': only a STRUCT can EXTEND another type`);
      done.add(key);
      return;
    }
    if (visiting.has(key)) {
      fail(td, `STRUCT '${td.name}' EXTENDS itself through '${td.extends}'`);
      for (const k of visiting) cyclic.add(k);
      return;
    }
    visiting.add(key);
    const def: StructDefinition = td.definition;
    const base = membersOf(td.extends);
    visiting.delete(key);
    done.add(key);
    if (cyclic.has(key)) return;
    if (base === undefined) {
      fail(
        td,
        `STRUCT '${td.name}' EXTENDS '${td.extends}', which is not a STRUCT`,
      );
      return;
    }
    const inherited = new Set(
      base.flatMap((d) => d.names.map((n) => n.toUpperCase())),
    );
    for (const own of def.fields) {
      for (const n of own.names) {
        if (inherited.has(n.toUpperCase())) {
          fail(
            td,
            `STRUCT '${td.name}' declares '${n}', a member it inherits from '${td.extends}'`,
          );
        }
      }
    }
    def.extends = td.extends;
    def.fields = [
      ...base.map((d) => ({
        ...d,
        inheritedFrom: d.inheritedFrom ?? td.extends!,
      })),
      ...def.fields,
    ];
  };

  for (const td of unit.types) lower(td);
  return errors;
}
