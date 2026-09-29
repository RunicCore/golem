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
 * Name for an anonymous projection written at `node`. A non-model type alias names it
 * (`TBilling` becomes `Billing`); otherwise the utility grammar; otherwise `fallback`
 * (owner model plus property, already PascalCase).
 */
export function projectionBaseName(
  checker: ts.TypeChecker,
  node: ts.TypeNode | undefined,
  modelNameOf: (declaration: ts.TypeAliasDeclaration) => string | undefined,
  fallback: string,
): string {
  if (!node) return fallback;
  const current = unwrap(node);
  if (ts.isTypeReferenceNode(current)) {
    const declaration = aliasDeclaration(checker, current);
    const utility = ts.isIdentifier(current.typeName) ? current.typeName.text : '';
    if (declaration && !modelNameOf(declaration) && !UTILITIES.has(utility)) {
      const alias = declaration.name.text;
      return /^T[A-Z]/.test(alias) ? alias.slice(1) : alias;
    }
  }
  return readable(checker, current, modelNameOf, 0) ?? fallback;
}

/**
 * The authored node that names one variant of a union: the union member whose type is the
 * variant, or the whole node when it is a single type made optional or nullable.
 */
export function variantNameNode(checker: ts.TypeChecker, node: ts.TypeNode | undefined, variant: ts.Type): ts.TypeNode | undefined {
  if (!node) return undefined;
  const current = unwrap(node);
  if (!ts.isUnionTypeNode(current)) return current;
  return current.types.find(member => checker.getTypeFromTypeNode(member) === variant);
}
