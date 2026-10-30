import * as ts from '../typescript-ns.js';
import { BUILTIN_CLASSES, type BuiltinClass } from '../builtin-classes.js';

/** The namespaces around a declaration, as the checker's API has no qualified name (TS 7). */
export interface Enclosure {
  /** The names of the enclosing namespaces, outermost first, up to a `declare global` block. */
  readonly namespaces: readonly string[];
  /** The outermost namespace that has a name. */
  readonly outermost?: ts.ModuleDeclaration;
  /** Whether a `declare global` block holds the declaration. */
  readonly augmentsGlobal: boolean;
  /** The name of the first `declare module "name"` around the declaration, which generated code cannot import from. */
  readonly quotedModule?: string;
}

export function enclosureOf(declaration: ts.Declaration): Enclosure {
  const namespaces: string[] = [];
  let outermost: ts.ModuleDeclaration | undefined;
  for (let parent: ts.Node | undefined = declaration.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (!ts.isModuleDeclaration(parent)) continue;
    if (ts.isStringLiteral(parent.name)) return { namespaces, ...(outermost ? { outermost } : {}), augmentsGlobal: false, quotedModule: parent.name.text };
    if (parent.name.text === 'global') return { namespaces, ...(outermost ? { outermost } : {}), augmentsGlobal: true };
    namespaces.unshift(parent.name.text);
    outermost = parent;
  }
  return { namespaces, ...(outermost ? { outermost } : {}), augmentsGlobal: false };
}

/** Whether the declaration is in the global scope: a `declare global` block, or a file with no top-level import or export (a lib, an ambient .d.ts). */
export function isGlobalDeclaration(declaration: ts.Declaration, enclosure: Enclosure): boolean {
  return enclosure.quotedModule === undefined && (enclosure.augmentsGlobal || !isModuleFile(declaration.getSourceFile()));
}

/** A file with a top-level import or export is a module; any other file declares globals. */
function isModuleFile(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => ts.isImportDeclaration(statement)
    || ts.isImportEqualsDeclaration(statement)
    || ts.isExportDeclaration(statement)
    || ts.isExportAssignment(statement)
    || ('modifiers' in statement && (statement.modifiers as readonly ts.Node[] | undefined)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) === true);
}

/**
 * The built-in class that `type` is, or undefined. The name is the qualified name of the global declaration (`Temporal.Instant`); a class that a
 * module exports under that name, such as a polyfill's, is not the global one: generated code would have to import it. The caller strips the
 * phantom brands of the type first.
 */
export function findBuiltinClass(type: ts.Type): BuiltinClass | undefined {
  const symbol = type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  if (symbol === undefined || declaration === undefined) return undefined;
  const enclosure = enclosureOf(declaration);
  if (!isGlobalDeclaration(declaration, enclosure)) return undefined;
  return BUILTIN_CLASSES.get([...enclosure.namespaces, symbol.getName()].join('.'));
}
