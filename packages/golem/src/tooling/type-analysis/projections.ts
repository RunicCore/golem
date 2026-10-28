import * as ts from '../typescript-ns.js';
import type { ModelSpecification } from './models.js';
import { resolveSymbol, isModelDeclarationReference } from './symbols.js';
import { manifestModelOfSymbol, type ResolvedModelManifestEntry } from './provenance.js';

interface Provenance {
  readonly models: readonly ModelSpecification[];
  readonly projection: boolean;
  /** The first IModel or IObject reference reached that no model specification declares. */
  readonly anonymous: ts.TypeReferenceNode | undefined;
  /** The SDK models that references to type aliases listed in a model manifest reach, each with the type of its reference. */
  readonly externals: readonly ExternalReference[];
}

interface ExternalReference {
  readonly model: ResolvedModelManifestEntry;
  readonly type: ts.Type;
}

/** Follow authored symbols and instantiated arguments; structural equality never establishes identity. */
export function fieldProvenance(
  checker: ts.TypeChecker,
  node: ts.TypeNode | undefined,
  specifications: readonly ModelSpecification[],
  manifests?: ReadonlyMap<string, ResolvedModelManifestEntry>,
): Provenance {
  const walk = (current: ts.TypeNode | undefined, substitutions = new Map<ts.Symbol, ts.TypeNode>(), seen = new Set<ts.Node>()): Provenance => {
    const empty: Provenance = { models: [], projection: false, anonymous: undefined, externals: [] };
    if (!current || seen.has(current)) return empty;
    const next = new Set(seen).add(current);
    if (ts.isParenthesizedTypeNode(current)) return walk(current.type, substitutions, next);
    if (ts.isTypeOperatorNode(current)) return { ...walk(current.type, substitutions, next), externals: [] };
    // A member of a model is a type of its own: the model it was read from is no candidate for it.
    if (ts.isIndexedAccessTypeNode(current)) return { ...walk(current.objectType, substitutions, next), models: [], externals: [] };
    if (ts.isMappedTypeNode(current)) {
      const source = walk(current.typeParameter.constraint, substitutions, next);
      return { ...source, projection: true, externals: [] };
    }
    if (ts.isUnionTypeNode(current) || ts.isIntersectionTypeNode(current)) {
      const members = current.types.map(member => walk(member, substitutions, next));
      return {
        models: [...new Set(members.flatMap(member => member.models))],
        projection: ts.isIntersectionTypeNode(current) && members.some(member => member.models.length > 0)
          || members.some(member => member.projection),
        anonymous: members.find(member => member.anonymous)?.anonymous,
        externals: members.flatMap(member => member.externals),
      };
    }
    if (!ts.isTypeReferenceNode(current)) return empty;
    if (isModelDeclarationReference(checker, current)) return { ...empty, anonymous: current };
    const symbol = resolveSymbol(checker, checker.getSymbolAtLocation(current.typeName));
    if (!symbol) return empty;
    const replacement = substitutionFor(symbol, substitutions, typeReferenceName(current));
    if (replacement) return walk(replacement, substitutions, next);
    const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
    if (!declaration) return empty;
    const external = manifests && manifestModelOfSymbol(manifests, symbol);
    if (external) return { ...empty, externals: [{ model: external, type: checker.getTypeFromTypeNode(current) }] };
    const direct = specifications.find(specification => specification.declaration === declaration);
    if (direct) return { ...empty, models: [direct] };
    const environment = new Map(substitutions);
    declaration.typeParameters?.forEach((parameter, index) => {
      const parameterSymbol = typeParameterSymbol(checker, parameter);
      const argument = current.typeArguments?.[index] ?? ts.typeParameterDefault(parameter);
      if (parameterSymbol && argument) environment.set(parameterSymbol, argument);
    });
    // Conditional utilities can retain unchanged members; the checker selects them later.
    if (ts.isConditionalTypeNode(declaration.type)) {
      const branches = [declaration.type.checkType, declaration.type.trueType, declaration.type.falseType]
        .map(branch => walk(branch, environment, next));
      return {
        models: [...new Set(branches.flatMap(branch => branch.models))],
        projection: branches.some(branch => branch.projection),
        anonymous: branches.find(branch => branch.anonymous)?.anonymous,
        externals: branches.flatMap(branch => branch.externals),
      };
    }
    return walk(declaration.type, environment, next);
  };
  return walk(node);
}

export function isPropertyMapping(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0
    && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0;
}

/** Preserve authored readonly array and tuple containers in generated model types. */
export function isReadonlySequenceType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (checker.isTupleType(type)) {
    return (ts.typeReferenceTarget(type) as ts.Type & { readonly readonly?: boolean } | undefined)?.readonly === true;
  }
  if (!checker.isArrayType(type)) return false;
  return ts.typeReferenceTarget(type)?.getSymbol?.()?.getName() === 'ReadonlyArray';
}

/** Readonly is a TypeScript modifier; it is neither freezing nor a wire annotation. */
export function readonlyPropertyNames(checker: ts.TypeChecker, type: ts.Type): readonly string[] {
  return checker.getPropertiesOfType(type).filter(property =>
    // A mapped property's modifier comes from the mapping (`Readonly<>`, `-readonly`), not its source declaration.
    (property.checkFlags & ts.CheckFlags.Mapped) !== 0
      ? (property.checkFlags & ts.CheckFlags.Readonly) !== 0
      : (property.declarations ?? checker.getRootSymbols(property).flatMap(root => root.declarations ?? [])).some(declaration =>
        ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some(item => item.kind === ts.SyntaxKind.ReadonlyKeyword)
      )).map(property => property.getName());
}

export type TypeSubstitutions = ReadonlyMap<ts.Symbol, ts.TypeNode>;

export function authoredPropertyTypeNode(node: ts.TypeNode | undefined, name: string): ts.TypeNode | undefined {
  if (!node || !ts.isTypeLiteralNode(node)) return undefined;
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) continue;
    const memberName = member.name;
    if (!memberName) continue;
    if (ts.isIdentifier(memberName) && memberName.text === name) return member.type;
    if (ts.isStringLiteralLike(memberName) && memberName.text === name) return member.type;
  }
  return undefined;
}

function typeParameterDeclaration(symbol: ts.Symbol | undefined): ts.TypeParameterDeclaration | undefined {
  return symbol?.declarations?.find(ts.isTypeParameterDeclaration);
}

function sameTypeParameter(left: ts.Symbol | undefined, right: ts.Symbol | undefined): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftDecl = typeParameterDeclaration(left);
  const rightDecl = typeParameterDeclaration(right);
  if (!leftDecl || !rightDecl) return false;
  if (leftDecl === rightDecl) return true;
  return leftDecl.getSourceFile().fileName === rightDecl.getSourceFile().fileName
    && leftDecl.getStart() === rightDecl.getStart();
}

function typeParameterSymbol(checker: ts.TypeChecker, parameter: ts.TypeParameterDeclaration): ts.Symbol | undefined {
  return resolveSymbol(checker, checker.getSymbolAtLocation(parameter.name))
    ?? resolveSymbol(checker, checker.getTypeAtLocation(parameter.name).getSymbol?.());
}

function typeReferenceName(node: ts.TypeReferenceNode): string | undefined {
  const name = node.typeName as { readonly text?: string; readonly escapedText?: string };
  return typeof name.text === 'string' ? name.text : typeof name.escapedText === 'string' ? name.escapedText : undefined;
}

function substitutionFor(symbol: ts.Symbol | undefined, substitutions: TypeSubstitutions, name?: string): ts.TypeNode | undefined {
  if (symbol) {
    const exact = substitutions.get(symbol);
    if (exact) return exact;
    for (const [candidate, replacement] of substitutions) {
      if (sameTypeParameter(symbol, candidate)) return replacement;
    }
  }
  if (!name) return undefined;
  const matches = [...substitutions].filter(([candidate]) => candidate.getName() === name);
  return matches.length === 1 ? matches[0][1] : undefined;
}

export function substituteTypeNode(checker: ts.TypeChecker, node: ts.TypeNode | undefined, substitutions: TypeSubstitutions): ts.TypeNode | undefined {
  const seen = new Set<ts.TypeNode>();
  while (node && ts.isTypeReferenceNode(node) && !seen.has(node)) {
    seen.add(node);
    const symbol = resolveSymbol(checker, checker.getSymbolAtLocation(node.typeName));
    const next = substitutionFor(symbol, substitutions, typeReferenceName(node));
    if (!next) break;
    node = next;
  }
  return node;
}

/** Carry the source arguments into properties whose declaration still says T. */
export function instantiatedTypeSource(checker: ts.TypeChecker, node: ts.TypeNode | undefined, substitutions: TypeSubstitutions): { node: ts.TypeNode | undefined; substitutions: TypeSubstitutions } {
  const environment = new Map(substitutions);
  const seen = new Set<ts.Node>();
  node = substituteTypeNode(checker, node, environment);
  while (node && ts.isTypeReferenceNode(node) && !seen.has(node)) {
    seen.add(node);
    const symbol = resolveSymbol(checker, checker.getSymbolAtLocation(node.typeName));
    const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
    if (!declaration || isModelDeclarationReference(checker, node)) break;
    declaration.typeParameters?.forEach((parameter, index) => {
      const parameterSymbol = typeParameterSymbol(checker, parameter);
      const argument = substituteTypeNode(
        checker,
        node && ts.isTypeReferenceNode(node) ? node.typeArguments?.[index] ?? ts.typeParameterDefault(parameter) : ts.typeParameterDefault(parameter),
        environment,
      );
      if (parameterSymbol && argument) environment.set(parameterSymbol, argument);
    });
    node = substituteTypeNode(checker, declaration.type, environment);
  }
  return { node, substitutions: environment };
}
