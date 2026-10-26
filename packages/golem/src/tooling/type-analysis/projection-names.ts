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

/** A type argument as part of a name: `string[]` is `StringArray`, so `Page<string[]>` and `Page<string[][]>` differ. Undefined when nothing identifier-like remains. */
function typeArgumentName(checker: ts.TypeChecker, argument: ts.Type): string | undefined {
  if (checker.isArrayType(argument)) {
    const item = checker.getTypeArguments(argument as ts.TypeReference)[0];
    const name = item && typeArgumentName(checker, item);
    return name && `${name}Array`;
  }
  if (checker.isTupleType(argument)) {
    const names = checker.getTypeArguments(argument as ts.TypeReference).map(item => typeArgumentName(checker, item));
    return names.every((name): name is string => name !== undefined) ? `Tuple${names.join('')}` : undefined;
  }
  return pascalIdentifier(checker.typeToString(argument));
}

/**
 * The parts that tell a recursive type from another one of its declared name, best first: the type arguments of a generic instance
 * (`Page<number>` gives `Number`), the name of its file without `.model.ts` or `.ts` (`b.model.ts` gives `B`), and both together.
 */
export function headQualifiers(checker: ts.TypeChecker, type: ts.Type): readonly string[] {
  const declaration = (type.aliasSymbol ?? type.getSymbol())?.declarations?.[0];
  const generic = declaration !== undefined && (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration))
    && (declaration.typeParameters?.length ?? 0) > 0;
  const argumentNames = !generic ? [] : (type.aliasSymbol ? type.aliasTypeArguments ?? [] : checker.getTypeArguments(type)).map(argument => typeArgumentName(checker, argument));
  const argumentPart = argumentNames.length > 0 && argumentNames.every((name): name is string => name !== undefined) ? argumentNames.join('') : undefined;
  const fileName = declaration?.getSourceFile().fileName;
  const filePart = fileName === undefined ? undefined : pascalIdentifier(fileName.slice(fileName.lastIndexOf('/') + 1).replace(/(?:\.models?)?(?:\.d)?\.[cm]?tsx?$/, ''));
  return [argumentPart, filePart, argumentPart !== undefined && filePart !== undefined ? `${argumentPart}${filePart}` : undefined]
    .filter((part): part is string => part !== undefined);
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
export function authoredUnionMembers(checker: ts.TypeChecker, node: ts.TypeNode | undefined): ts.TypeNode[] | undefined {
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
