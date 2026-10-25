import { compareText } from '../generator-api.js';
import * as ts from '../typescript-ns.js';
import { resolveSymbol } from './symbols.js';

export interface ProjectionPolicy {
  readonly exact: boolean;
  readonly allowAny: boolean;
  readonly representation: 'model' | 'wire';
}

export const MAX_PROJECTION_DEPTH = 3;
export const MAX_PROJECTION_KEYS = 3;
const UTILITIES = new Set(['Pick', 'Omit', 'Partial', 'Required', 'Readonly']);
const KEYED = new Set(['Pick', 'Omit']);

export function policySuffix(policy: ProjectionPolicy): string {
  return `${policy.exact ? '' : 'Loose'}${policy.allowAny ? 'Any' : ''}${policy.representation === 'wire' ? 'Wire' : ''}`;
}

/** `first-name` becomes `FirstName`; undefined when the key has no ASCII letters or digits. */
export function pascalIdentifier(key: string): string | undefined {
  if (/[^\x00-\x7F]/.test(key)) return undefined;
  const parts = key.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map(part => part[0]!.toUpperCase() + part.slice(1)).join('');
}

function unwrap(node: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(node) ? unwrap(node.type) : node;
}

function aliasDeclaration(checker: ts.TypeChecker, node: ts.TypeReferenceNode): ts.TypeAliasDeclaration | undefined {
  const symbol = resolveSymbol(checker, checker.getSymbolAtLocation(node.typeName));
  return symbol?.declarations?.find(ts.isTypeAliasDeclaration);
}

function literalKeys(node: ts.TypeNode): string[] | undefined {
  const current = unwrap(node);
  if (ts.isLiteralTypeNode(current) && ts.isStringLiteral(current.literal)) return [current.literal.text];
  if (ts.isUnionTypeNode(current)) {
    const keys = current.types.map(member => literalKeys(member));
    return keys.every((item): item is string[] => item !== undefined) ? keys.flat() : undefined;
  }
  return undefined;
}

function readable(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  modelNameOf: (declaration: ts.TypeAliasDeclaration) => string | undefined,
  depth: number,
): string | undefined {
  const current = unwrap(node);
  if (ts.isIntersectionTypeNode(current)) {
    const names = current.types.map(member => {
      const inner = unwrap(member);
      if (!ts.isTypeReferenceNode(inner)) return undefined;
      const declaration = aliasDeclaration(checker, inner);
      return declaration ? modelNameOf(declaration) : undefined;
    });
    return names.every((name): name is string => name !== undefined) ? [...names].sort().join('And') : undefined;
  }
  if (!ts.isTypeReferenceNode(current)) return undefined;
  const declaration = aliasDeclaration(checker, current);
  const model = declaration ? modelNameOf(declaration) : undefined;
  if (model) return model;
  if (depth === 0 && declaration) {
    const alias = aliasProjectionName(declaration);
    if (alias) return alias;
  }
  const utility = ts.isIdentifier(current.typeName) ? current.typeName.text : undefined;
  if (!utility || !UTILITIES.has(utility) || !current.typeArguments?.length) return undefined;
  if (depth >= MAX_PROJECTION_DEPTH) return undefined;
  const inner = readable(checker, current.typeArguments[0]!, modelNameOf, depth + 1);
  if (!inner) return undefined;
  if (!KEYED.has(utility)) return `${inner}${utility}`;
  const keys = current.typeArguments[1] ? literalKeys(current.typeArguments[1]) : undefined;
  if (!keys || keys.length === 0 || keys.length > MAX_PROJECTION_KEYS) return undefined;
  const parts = [...keys].sort().map(pascalIdentifier);
  return parts.every((part): part is string => part !== undefined) ? `${inner}${utility}${parts.join('')}` : undefined;
}

/**
 * A type alias names its projection only when it is a concrete, authored alias: no type
 * parameters, not declared in a `.d.ts` file (so lib aliases such as `Record` never name),
 * and a name that survives the same identifier check as keys. `TBilling` stays `TBilling`.
 */
export function aliasProjectionName(declaration: ts.TypeAliasDeclaration): string | undefined {
  if (declaration.typeParameters?.length || declaration.getSourceFile().isDeclarationFile) return undefined;
  return pascalIdentifier(declaration.name.text);
}

/**
 * Name for an anonymous projection written at `node`: a concrete non-model type alias, then
 * the utility grammar, then `fallback` (owner model plus property, already PascalCase).
 */
export function projectionBaseName(
  checker: ts.TypeChecker,
  node: ts.TypeNode | undefined,
  modelNameOf: (declaration: ts.TypeAliasDeclaration) => string | undefined,
  fallback: string,
): string {
  return (node && readable(checker, node, modelNameOf, 0)) || fallback;
}

/** The first declaration of the alias, interface or class that declares a type. */
function declarationOf(type: ts.Type): ts.Declaration | undefined {
  return (type.aliasSymbol ?? type.getSymbol())?.declarations?.[0];
}

/** The type arguments of a generic instance: those of its alias, else those of its reference to a generic interface or class. */
function instanceArguments(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if (type.aliasSymbol) return type.aliasTypeArguments ?? [];
  const declaration = declarationOf(type);
  const generic = declaration !== undefined && (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration))
    && (declaration.typeParameters?.length ?? 0) > 0;
  return generic ? checker.getTypeArguments(type) : [];
}

/**
 * The stem of a recursive type whose declared name another type already uses: the stem and the type arguments of a generic instance
 * (`Page<number>` after `Page<string>` gives `PageNumber`), else the stem and the file stem (`b.model.ts` gives `NodeB`).
 * Undefined when the type has neither.
 */
export function qualifiedHeadStem(checker: ts.TypeChecker, type: ts.Type, stem: string): string | undefined {
  const argumentParts = instanceArguments(checker, type).map(argument => pascalIdentifier(checker.typeToString(argument)));
  if (argumentParts.length > 0 && argumentParts.every((part): part is string => part !== undefined)) return `${stem}${argumentParts.join('')}`;
  const fileName = declarationOf(type)?.getSourceFile().fileName;
  const base = fileName?.slice(fileName.lastIndexOf('/') + 1).replace(/(?:\.models?)?(?:\.d)?\.[cm]?tsx?$/, '');
  const filePart = base === undefined ? undefined : pascalIdentifier(base);
  return filePart === undefined ? undefined : `${stem}${filePart}`;
}

const PROJECTION_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export function isProjectionName(name: string): boolean {
  return PROJECTION_NAME.test(name);
}

/**
 * `hint` as a plain ASCII PascalCase identifier (`Order_V2` becomes `OrderV2`); `owner` when
 * nothing identifier-like remains or the name is compiler-internal (`__type`).
 */
export function safeNameHint(hint: string, owner: string): string {
  if (hint.startsWith('__')) return owner;
  const cleaned = pascalIdentifier(hint);
  return cleaned !== undefined && isProjectionName(cleaned) ? cleaned : owner;
}

/** A concrete type alias of a union, such as `type TEither = A | B`. */
function unionAlias(checker: ts.TypeChecker, node: ts.TypeNode): ts.TypeAliasDeclaration | undefined {
  if (!ts.isTypeReferenceNode(node) || node.typeArguments?.length) return undefined;
  const declaration = aliasDeclaration(checker, node);
  return declaration && !declaration.typeParameters?.length && ts.isUnionTypeNode(unwrap(declaration.type)) ? declaration : undefined;
}

/** Members in authored order; an alias of a union inside a union contributes its own members. */
function flattenUnion(checker: ts.TypeChecker, node: ts.TypeNode, seen: ReadonlySet<ts.TypeAliasDeclaration> = new Set()): ts.TypeNode[] {
  const current = unwrap(node);
  if (ts.isUnionTypeNode(current)) return current.types.flatMap(member => flattenUnion(checker, member, seen));
  const alias = unionAlias(checker, current);
  if (alias && !seen.has(alias)) return flattenUnion(checker, alias.type, new Set([...seen, alias]));
  return [current];
}

/** The members of the union as authored, also through a concrete type alias of a union. */
function authoredUnionMembers(checker: ts.TypeChecker, node: ts.TypeNode | undefined): ts.TypeNode[] | undefined {
  if (!node) return undefined;
  const current = unwrap(node);
  return ts.isUnionTypeNode(current) || unionAlias(checker, current) ? flattenUnion(checker, current) : undefined;
}

export interface UnionVariantNaming {
  /** Appended to the owner hint when the variant falls back to owner plus property. */
  readonly part: string;
  /** The authored node that names the variant through the grammar. */
  readonly node: ts.TypeNode | undefined;
}

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

/**
 * Names for the variants of a union, independent of the checker's type order. The part is
 * the PascalCased value of a string-literal property every variant has (the first property
 * in sorted order whose values stay distinct), otherwise the 1-based position of the
 * variant's member in the union as written. Variants that match no authored member are
 * numbered by their sorted type text. A union with fewer than two non-nullish variants needs
 * no part.
 */
export function unionVariantNaming(
  checker: ts.TypeChecker,
  node: ts.TypeNode | undefined,
  variants: readonly ts.Type[],
  location: ts.Node,
): ReadonlyMap<ts.Type, UnionVariantNaming> {
  const result = new Map<ts.Type, UnionVariantNaming>();
  const named = variants.filter(variant => (variant.flags & NULLISH) === 0);
  const members = authoredUnionMembers(checker, node);
  const memberTypes = members?.map(member => checker.getTypeFromTypeNode(member));
  const indexOf = (variant: ts.Type): number => memberTypes?.indexOf(variant) ?? -1;
  const nodeOf = (variant: ts.Type): ts.TypeNode | undefined => {
    const index = indexOf(variant);
    if (index >= 0) return members![index];
    return !members && node && named.length === 1 ? unwrap(node) : undefined;
  };
  if (named.length < 2) {
    for (const variant of named) result.set(variant, { part: '', node: nodeOf(variant) });
    return result;
  }
  const literalOf = (variant: ts.Type, property: string): string | undefined => {
    const symbol = checker.getPropertyOfType(variant, property);
    if (!symbol) return undefined;
    const type = checker.getTypeOfSymbolAtLocation(symbol, location);
    return type.flags & ts.TypeFlags.StringLiteral ? (type as ts.StringLiteralType).value : undefined;
  };
  const shared = checker.getPropertiesOfType(named[0]!).map(symbol => symbol.getName())
    .filter(property => named.every(variant => literalOf(variant, property) !== undefined)).sort();
  for (const property of shared) {
    const pascal = named.map(variant => pascalIdentifier(literalOf(variant, property)!));
    if (pascal.every((value): value is string => value !== undefined) && new Set(pascal).size === named.length) {
      named.forEach((variant, index) => result.set(variant, { part: pascal[index]!, node: nodeOf(variant) }));
      return result;
    }
  }
  const matched = named.every(variant => indexOf(variant) >= 0);
  const order = matched ? undefined : [...named].sort((left, right) => {
    return compareText(checker.typeToString(left), checker.typeToString(right));
  });
  named.forEach(variant => {
    const position = order ? order.indexOf(variant) : indexOf(variant);
    result.set(variant, { part: String(position + 1), node: nodeOf(variant) });
  });
  return result;
}
