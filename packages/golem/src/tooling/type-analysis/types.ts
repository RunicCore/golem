import path from 'node:path';
import { fieldProvenance, isPropertyMapping, isReadonlySequenceType, readonlyPropertyNames, instantiatedTypeSource, substituteTypeNode, authoredPropertyTypeNode, type TypeSubstitutions } from './projections.js';
import * as ts from '../typescript-ns.js';
import { assertNoSymbolKey, declaredModelAlias, isDefaultLibraryProperty, isSymbolKeyedProperty, diagnostic, foreignModelReason, isGeneratedBrandKey, modelSpecificationForClass, propertyType, resolveSymbol } from './symbols.js';
import { projectionIdentity } from './graph.js';
import { aliasProjectionName, isProjectionName, pascalIdentifier, policySuffix, headQualifiers, projectionBaseName, keysReadAlike, safeNameHint, unionVariantNaming } from './projection-names.js';
import { commonDirectory, canonicalFilename, companionFilename, type ModelBoundary } from './project.js';
import { packageSpecifier } from './package-specifier.js';
import { TEMPORAL_SERDE_PREFIX } from '../sdk-codecs.js';
import { compareText, displayPath } from '../generator-core.js';
import type { GolemProfile } from '../generator-core.js';
import { assertSupportedModelFieldName, canonicalDescriptorKey, isBrandPropertyName } from '../schema.js';
import type {
  ModelConversionDescriptor,
  TupleConversionDescriptor,
} from '../model-source-emitter.js';
import type { DiscriminatorValue, UnionDiscriminator } from '../../model-registry.js';
import type { ManifestIndex } from './provenance.js';
import type { ModelSpecification, TypeAnalysisContext } from './models.js';
import {
  analyzeNode,
  checkerDiscriminator,
  untaggedTypeText,
  withoutDiscriminator,
  carriesSerdeTag,
  isAmbientOrGlobalSymbol,
  isDateType,
  isGolemTagKey,
  publicExportName,
  type ModelConstraint,
  type SerdeBinding,
  type TagMetadata,
  type ValidationBinding,
} from './tags.js';

export type { ModelConversionDescriptor, TupleConversionDescriptor } from '../model-source-emitter.js';

/** Additive compiler metadata consumed by the shared model runtime. */
export interface ModelDescriptorMetadata {
  readonly validations?: readonly ValidationBinding[];
  readonly serde?: SerdeBinding;
  readonly constraints?: readonly ModelConstraint[];
  readonly date?: true;
}

type InternalSerdeBinding = SerdeBinding & {
  /** Filled after recursively describing the inferred wire parameter. */
  readonly wireDescriptor?: ModelConversionDescriptor;
};

type InternalTagMetadata = Omit<TagMetadata, 'serde'> & {
  readonly serde?: InternalSerdeBinding;
};

export type RichModelConversionDescriptor = ModelConversionDescriptor & ModelDescriptorMetadata;

function primitiveConstructorDescriptor(type: ts.Type): ModelConversionDescriptor | undefined {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (!isAmbientOrGlobalSymbol(symbol)) return undefined;
  switch (symbol?.getName()) {
    case 'String':
      return { kind: 'string' };
    case 'Number':
      return { kind: 'number' };
    case 'Boolean':
      return { kind: 'boolean' };
    case 'BigInt':
      return { kind: 'bigint' };
    case 'Date':
      return { kind: 'date' };
    default:
      return undefined;
  }
}

/** The name of a global `Map`, `Set`, `ReadonlyMap` or `ReadonlySet`; JSON writes each as `{}`. Undefined for any other type. */
function mapOrSetName(type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  if (!isAmbientOrGlobalSymbol(symbol)) return undefined;
  const name = symbol?.getName();
  return name === 'Map' || name === 'Set' || name === 'ReadonlyMap' || name === 'ReadonlySet' ? name : undefined;
}

/** The RUNM1086 message; only a class field can take the `@ApiProperty` advice. */
function mapOrSetDtoMessage(where: string, collection: string, decoratable: boolean): string {
  return `${where} is a ${collection}. JSON writes a ${collection} as {}, so no schema describes it. `
    + (decoratable ? 'Give the field an @ApiProperty with type, schema or additionalProperties, or use a Record or an array.' : 'Use a Record or an array.');
}

/** True when the property is declared as a class field, which a decorator can reach; a type literal or interface member has none. */
function isClassProperty(property: ts.Symbol): boolean {
  return (property.declarations ?? []).some(declaration => ts.isPropertyDeclaration(declaration));
}

/** True when the property has `@ApiProperty` or `@ApiPropertyOptional` with a `type`, `schema` or `additionalProperties` the user wrote. */
function carriesExplicitSwaggerSchema(property: ts.Symbol): boolean {
  return (property.declarations ?? []).some(declaration => ts.canHaveDecorators(declaration) && (ts.getDecorators(declaration) ?? []).some(decorator => {
    if (!ts.isCallExpression(decorator.expression)) return false;
    const callee = decorator.expression.expression;
    const decoratorName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
    if (decoratorName !== 'ApiProperty' && decoratorName !== 'ApiPropertyOptional') return false;
    const [options] = decorator.expression.arguments;
    return options !== undefined && ts.isObjectLiteralExpression(options) && options.properties.some(item => (
      (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item))
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
      && ['type', 'schema', 'additionalProperties'].includes(item.name.text)
    ));
  }));
}

function propertyTypeNode(checker: ts.TypeChecker, property: ts.Symbol, valueType: ts.Type): ts.TypeNode | undefined {
  const roots = checker.getRootSymbols(property);
  const root = roots.length === 1 ? roots[0] : undefined;
  // A property merged from an intersection has a declaration in each member; the one whose type the merged type equals names it,
  // as `pets: TCat[]` in `TOwner & { pets: TCat[] }` where TOwner declares `pets: TPet[]`.
  const merged = property.valueDeclaration ? undefined : property.declarations?.find((candidate) =>
    (ts.isPropertySignature(candidate) || ts.isPropertyDeclaration(candidate)) && candidate.type
    && checker.isTypeAssignableTo(checker.getTypeFromTypeNode(candidate.type), valueType));
  const declaration = property.valueDeclaration ?? merged ?? property.declarations?.[0] ?? root?.valueDeclaration ?? root?.declarations?.[0];
  return declaration && (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration))
    ? declaration.type
    : undefined;
}

function tupleTarget(type: ts.Type): ts.TypeReference {
  return type as ts.TypeReference;
}

/** `bigint` itself, not a bigint literal or a union containing one. */
function isBigIntValueType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.BigInt) !== 0;
}

/** An instance type with behavior: call/construct signatures or methods. Arrays and tuples are data. */
function isClassValueType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0 || checker.isArrayType(type) || checker.isTupleType(type)) return false;
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return true;
  return checker.getPropertiesOfType(type).some((property) =>
    (property.flags & ts.SymbolFlags.Method) !== 0
    || property.declarations?.some((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) === true);
}

/** The name generated code writes for the class, and the import it needs, if any. */
function classValueReference(
  checker: ts.TypeChecker,
  type: ts.Type,
  context: TypeAnalysisContext,
  node: ts.Node,
  identityRoot: string,
  /** The generated file that imports the class: the companion of the model's file. */
  importer: string,
): { typeName: string; typeImport?: { exportName: string; module: string; specifier?: string } } {
  // The class's own symbol, never a local alias such as `type Bytes = Uint8Array & TSerde<…>`,
  // which the model file need not export.
  const symbol = type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration) throw diagnostic(context.sourceFile, context.declaration, '1004', `A TSerde class type in ${context.name} has no declaration.`);
  const declaredName = (declaration as ts.NamedDeclaration).name;
  // A class expression or type literal carries an internal `__class` / `__type` name; `export default class {}` is named `default`.
  if (!declaredName && symbol.getName().startsWith('__')) {
    throw diagnostic(context.sourceFile, node, '1063', `The class of a TSerde field in ${context.name} has no name, so generated code cannot import it. Name the class and export it.`);
  }
  // TS 7's API has no getFullyQualifiedName: qualify by the enclosing namespaces instead.
  const names = [declaredName && ts.isIdentifier(declaredName) ? declaredName.text : symbol.getName()];
  let augmentsGlobal = false;
  let outermost: ts.ModuleDeclaration | undefined;
  for (let parent: ts.Node | undefined = declaration.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (!ts.isModuleDeclaration(parent)) continue;
    if (ts.isStringLiteral(parent.name)) {
      throw diagnostic(context.sourceFile, node, '1063', `Class ${names.join('.')} is declared inside declare module ${JSON.stringify(parent.name.text)}, which generated code cannot import from. Move it into a module file and export it.`);
    }
    if (parent.name.text === 'global') { augmentsGlobal = true; break; }
    names.unshift(parent.name.text);
    outermost = parent;
  }
  const typeName = names.join('.');
  if (hasRequiredTypeParameter(symbol)) {
    throw diagnostic(context.sourceFile, node, '1063', `Class ${typeName} has type parameters, so generated code cannot write its type. Use a non-generic class, such as one declared as \`class Named extends ${typeName}<string> {}\`.`);
  }
  // A script file (a TypeScript lib, an ambient .d.ts) or a `declare global` block declares a global name.
  if (augmentsGlobal || !isModuleFile(declaration.getSourceFile())) return { typeName };
  const sourceFile = declaration.getSourceFile();
  // `Temporal` for `Temporal.Instant` imported from a module: the outermost namespace is what the module exports.
  const exportName = publicExportName(checker, outermost ?? declaration, (outermost && checker.getSymbolAtLocation(outermost.name)) || symbol, true);
  if (!exportName) {
    throw diagnostic(context.sourceFile, node, '1063', `Class ${typeName} is not exported from ${path.relative(path.dirname(context.sourceFile.fileName), sourceFile.fileName)}, so generated code cannot import it. Export it.`);
  }
  const module = canonicalFilename(sourceFile.fileName);
  const resolved = packageSpecifier(module, importer, identityRoot);
  if (resolved.kind === 'unexported') {
    throw diagnostic(context.sourceFile, node, '1060', `Class ${typeName} is in package ${resolved.packageName}, but no "exports" entry reaches ${module}. Export that file from the package.`);
  }
  return { typeName, typeImport: { exportName, module, ...(resolved.kind === 'package' ? { specifier: resolved.specifier } : {}) } };
}

/** Whether writing the class's bare name would omit a type argument: some type parameter has no default in any merged declaration. */
function hasRequiredTypeParameter(symbol: ts.Symbol): boolean {
  const lists = (symbol.declarations ?? [])
    .filter((item): item is ts.ClassLikeDeclaration | ts.InterfaceDeclaration => ts.isClassLike(item) || ts.isInterfaceDeclaration(item))
    .map((item) => item.typeParameters ?? []);
  const count = Math.max(0, ...lists.map((list) => list.length));
  return Array.from({ length: count }, (_, index) => lists.some((list) => { const parameter = list[index]; return parameter !== undefined && ts.typeParameterDefault(parameter) !== undefined; })).some((defaulted) => !defaulted);
}

const TEMPORAL_CLASSES: ReadonlySet<string> = new Set(['Instant', 'ZonedDateTime', 'PlainDate', 'PlainDateTime', 'PlainTime', 'Duration']);

/**
 * The name of the global `Temporal` class that `type` is (`Instant` for `Temporal.Instant`), or undefined. A `Temporal` that a module
 * exports, such as a polyfill's, is not the global one: generated code would have to import it.
 */
function globalTemporalClass(type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  const name = symbol?.getName();
  if (declaration === undefined || name === undefined || !TEMPORAL_CLASSES.has(name)) return undefined;
  let outermost: ts.ModuleDeclaration | undefined;
  let augmentsGlobal = false;
  for (let parent: ts.Node | undefined = declaration.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (!ts.isModuleDeclaration(parent)) continue;
    if (!ts.isIdentifier(parent.name)) return undefined;
    if (parent.name.text === 'global') { augmentsGlobal = true; break; }
    outermost = parent;
  }
  const global = augmentsGlobal || !isModuleFile(declaration.getSourceFile());
  return global && outermost !== undefined && ts.isIdentifier(outermost.name) && outermost.name.text === 'Temporal' ? name : undefined;
}

/** A file with a top-level import or export is a module; any other file declares globals. */
function isModuleFile(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => ts.isImportDeclaration(statement)
    || ts.isImportEqualsDeclaration(statement)
    || ts.isExportDeclaration(statement)
    || ts.isExportAssignment(statement)
    || ('modifiers' in statement && (statement.modifiers as readonly ts.Node[] | undefined)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) === true);
}

function rejectAmbiguousGeneratedModelUnion(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }>,
  context: TypeAnalysisContext,
): void {
  const generated = descriptor.variants.filter((item) => item.kind === 'generated-model');
  if (generated.length > 1) {
    throw diagnostic(
      context.sourceFile,
      context.declaration,
      '1030',
      `Generated model union in ${context.name} has multiple generated model alternatives. Add a single generated branch with a uniquely tagged object alternative.`,
    );
  }
  if (generated.length !== 1) return;
  const alternatives = descriptor.variants.filter((item) => item.kind !== 'generated-model');
  // A declared tag table leaves the array to its JSON type: only an object value reaches the model.
  if (alternatives.some((item) =>
    item.kind === 'any'
      || item.kind === 'unknown'
      || (item.kind === 'array' && descriptor.discriminator === undefined)
      || item.kind === 'intersection'
  )) {
    throw diagnostic(
      context.sourceFile,
      context.declaration,
      '1030',
      `Generated model union in ${context.name} has an ambiguous object alternative. Use a primitive or a uniquely tagged object branch.`,
    );
  }
}

/** A type that holds other types: an object, an array, a tuple, a union or an intersection. */
function isStructured(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0 || type.isUnion() || type.isIntersection();
}

/** An intersection of plain object types, which `describe` reads as one merged object. */
function isObjectLikeIntersection(checker: ts.TypeChecker, type: ts.Type): boolean {
  return type.isIntersection()
    && type.types.length > 0
    && type.types.every((member) =>
      (member.flags & ts.TypeFlags.Object) !== 0
      && !checker.isArrayType(member)
      && !checker.isTupleType(member)
      && member.getCallSignatures().length === 0
      && member.getConstructSignatures().length === 0,
    );
}

/** A plain object type whose every property is a brand (`{ readonly __brand: 'Timestamp' }`, `{ __brand?: never }`): a type-only mark, no data. */
function isBrandMember(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0 || isDateType(checker, type) || checker.isArrayType(type) || checker.isTupleType(type)) return false;
  const properties = checker.getPropertiesOfType(type);
  return properties.length > 0 && type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0
    && properties.every((property) => isBrandPropertyName(property.getName()));
}

/** The members of an intersection that carry data: the brand members drop out. */
function dataMembers(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  return type.isIntersection() ? type.types.filter((member) => !isBrandMember(checker, member)) : [type];
}

/** A Date with only brands beside it, such as `Date & { readonly __brand: 'Timestamp' }`: it is a Date. */
function isBrandedDate(checker: ts.TypeChecker, type: ts.Type): boolean {
  const members = dataMembers(checker, type);
  return type.isIntersection() && members.length === 1 && isDateType(checker, members[0]!);
}

/**
 * The scalar that golem converts by its own rule (a Date, a bigint) in an intersection with an object type, such as `Date & TModel`.
 * An intersection is AND, and no value is both a scalar and an object, so the field has no valid value. A brand is no object.
 */
function scalarIntersectedWithObject(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  if (!type.isIntersection()) return undefined;
  const members = dataMembers(checker, type);
  const scalar = members.find((member) => isDateType(checker, member) || isBigIntValueType(member));
  const object = members.some((member) => (member.flags & ts.TypeFlags.Object) !== 0 && !isDateType(checker, member));
  return scalar && object ? (isBigIntValueType(scalar) ? 'bigint' : 'Date') : undefined;
}

/**
 * The name of the type alias that the user wrote for a type: a concrete alias with no type parameters, declared outside
 * a declaration file (`Record` and `Partial` never name). A generic alias or no alias has none.
 */
function userAliasName(type: ts.Type): string | undefined {
  const declaration = type.aliasSymbol?.declarations?.find(ts.isTypeAliasDeclaration);
  return declaration ? aliasProjectionName(declaration) : undefined;
}

/**
 * How many different instances of one generic declaration a walk may hold at once. A type that makes a new type argument on each
 * level never repeats, so the walk stops when the next instance would be one more than this. It is golem's own bound; the
 * `maxExpansionDepth` option of `descriptorBuilder` sets another.
 */
const DEFAULT_MAX_EXPANSION_DEPTH = 100;

/**
 * The name of the interface, class or generic type alias that declares a type. A recursive type with no concrete alias takes it,
 * so every lap of the cycle names the projection the same and the second lap ends in a reference.
 */
function declaredTypeName(type: ts.Type): string | undefined {
  const name = (type.aliasSymbol ?? type.getSymbol())?.getName();
  return name === undefined || name.startsWith('__') ? undefined : name;
}

/** The `any` of a type that did not resolve, such as a failed import. */
export function isErrorAny(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0
    && type.aliasSymbol !== undefined
    && (type.aliasSymbol.flags & ts.SymbolFlags.Transient) !== 0;
}

/**
 * The single model whose fields are mutually assignable with a type.  This
 * compares against every specification, so callers evaluate it only on the
 * branches that consume it and memoize it per builder.
 */
function uniqueStructuralModel(
  checker: ts.TypeChecker,
  type: ts.Type,
  specifications: readonly ModelSpecification[],
): ModelSpecification | undefined {
  const matches = specifications.filter((specification) => (
    checker.isTypeAssignableTo(type, specification.fieldsType)
    && checker.isTypeAssignableTo(specification.fieldsType, type)
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

function modelSpecificationForType(
  checker: ts.TypeChecker,
  type: ts.Type,
  specifications: readonly ModelSpecification[],
): ModelSpecification | undefined {
  const symbol = resolveSymbol(checker, type.aliasSymbol ?? type.getSymbol?.());
  const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
  if (!declaration) return undefined;
  return specifications.find((specification) => specification.declaration === declaration);
}

function isPhantomTagType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  return checker.getPropertiesOfType(type).some((property) => isGolemTagKey(checker, property));
}

function stripPhantomIntersection(
  checker: ts.TypeChecker,
  type: ts.Type,
  metadata: TagMetadata,
): ts.Type {
  if (!metadata.validations.length && !metadata.serde && !metadata.constraints.length && metadata.discriminator === undefined) return type;
  if (!type.isIntersection()) return type;
  const members = type.types.filter((member) => !isPhantomTagType(checker, member));
  return members.length === 1 ? members[0] : type;
}

function assertSerdeCompatibility(
  checker: ts.TypeChecker,
  serde: InternalSerdeBinding,
  modelType: ts.Type,
  context: TypeAnalysisContext,
): void {
  const checks: readonly [ts.Type, ts.Type, string][] = [
    [modelType, serde.modelType, 'serialize parameter'],
    [serde.serializeType, serde.wireType, 'serialize result'],
    [serde.deserializeType, modelType, 'deserialize result'],
  ];
  for (const [source, target, role] of checks) {
    if (!checker.isTypeAssignableTo(source, target)) {
      throw diagnostic(
        context.sourceFile,
        context.declaration,
        '1049',
        `Serde ${role} is incompatible with ${context.name}: ${checker.typeToString(source)} is not assignable to ${checker.typeToString(target)}.`,
      );
    }
  }
}

function assertValidationCompatibility(
  checker: ts.TypeChecker,
  validations: readonly ValidationBinding[],
  modelType: ts.Type,
  context: TypeAnalysisContext,
): void {
  for (const validation of validations) {
    if (!checker.isTypeAssignableTo(modelType, validation.parameterType)) {
      throw diagnostic(
        context.sourceFile,
        context.declaration,
        '1050',
        `Validation parameter is incompatible with ${context.name}: ${checker.typeToString(modelType)} is not assignable to ${checker.typeToString(validation.parameterType)}.`,
      );
    }
  }
}

type ConstraintFamily = 'number' | 'string' | 'array' | 'object';

/** The `Format` names that validate a number. `validation-runtime.ts` checks them; every other name checks a string. */
const NUMBER_FORMATS: ReadonlySet<string> = new Set(['int32', 'int64', 'float', 'double']);

function constraintFamily(constraint: ModelConstraint): ConstraintFamily | undefined {
  switch (constraint.kind) {
    case 'integer':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'multipleOf':
      return 'number';
    case 'format':
      return NUMBER_FORMATS.has(constraint.value) ? 'number' : 'string';
    case 'minLength':
    case 'maxLength':
    case 'pattern':
      return 'string';
    case 'minItems':
    case 'maxItems':
    case 'contains':
    case 'minContains':
    case 'maxContains':
    case 'uniqueItems':
      return 'array';
    case 'minProperties':
    case 'maxProperties':
    case 'propertyNames':
    case 'patternProperties':
    case 'additionalProperties':
    case 'unevaluatedProperties':
    case 'dependentRequired':
    case 'dependentSchemas':
      return 'object';
  }
}

function supportsConstraintFamily(
  checker: ts.TypeChecker,
  type: ts.Type,
  family: ConstraintFamily,
  seen = new Set<ts.Type>(),
): boolean {
  if (seen.has(type)) return true;
  seen.add(type);

  // A tag on any/unknown is an explicit constraint.  It must be retained in
  // the descriptor without pretending that the value has the tag's schema
  // family.  JSON Schema will then apply the constraint only where it has a
  // meaningful keyword, while other values remain admitted by any/unknown.
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
  if ((type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return true;
  if (type.isUnion()) return type.types.every((member) => supportsConstraintFamily(checker, member, family, seen));
  if (type.isIntersection()) return type.types.every((member) => supportsConstraintFamily(checker, member, family, seen));

  switch (family) {
    case 'number': return (type.flags & ts.TypeFlags.NumberLike) !== 0;
    case 'string': return (type.flags & ts.TypeFlags.StringLike) !== 0;
    case 'array': return checker.isArrayType(type) || checker.isTupleType(type);
    case 'object': return (type.flags & ts.TypeFlags.Object) !== 0
      && !checker.isArrayType(type)
      && !checker.isTupleType(type)
      && type.getCallSignatures().length === 0
      && type.getConstructSignatures().length === 0;
  }
}

function assertConstraintCompatibility(
  checker: ts.TypeChecker,
  constraints: readonly ModelConstraint[],
  valueType: ts.Type,
  context: TypeAnalysisContext,
  representation: 'model' | 'wire',
): void {
  const hasContains = constraints.some((constraint) => constraint.kind === 'contains');
  for (const constraint of constraints) {
    if ((constraint.kind === 'minContains' || constraint.kind === 'maxContains') && !hasContains) {
      throw diagnostic(
        context.sourceFile,
        context.declaration,
        '1051',
        `${constraint.kind === 'minContains' ? 'MinContains' : 'MaxContains'} requires a Contains constraint on the same ${representation} value.`,
      );
    }
  }
  const families = new Set<ConstraintFamily>();
  for (const constraint of constraints) {
    const family = constraintFamily(constraint);
    if (family) families.add(family);
  }
  for (const family of families) {
    if (supportsConstraintFamily(checker, valueType, family)) continue;
    throw diagnostic(
      context.sourceFile,
      context.declaration,
      '1051',
      `Constraint on the ${representation} value requires ${family === 'array' || family === 'object' ? 'an' : 'a'} ${family} type, but ${context.name} resolves to ${checker.typeToString(valueType)}.`,
    );
  }
}

function typeArgumentNode(node: ts.TypeNode | undefined, index: number): ts.TypeNode | undefined {
  while (node && ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) node = node.type;
  return node && ts.isTypeReferenceNode(node) ? node.typeArguments?.[index] : undefined;
}

function arrayItemNameNode(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  while (node && ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) node = node.type;
  return node && ts.isArrayTypeNode(node) ? node.elementType : typeArgumentNode(node, 0);
}

function tupleElementNode(node: ts.TypeNode | undefined, index: number): ts.TypeNode | undefined {
  while (node && ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) node = node.type;
  if (!node || !ts.isTupleTypeNode(node)) return typeArgumentNode(node, index);
  let item = node.elements[index];
  if (!item) return undefined;
  if (ts.isNamedTupleMember(item)) item = item.dotDotDotToken && ts.isArrayTypeNode(item.type) ? item.type.elementType : item.type;
  if (ts.isOptionalTypeNode(item)) item = item.type;
  if (ts.isRestTypeNode(item)) item = ts.isArrayTypeNode(item.type) ? item.type.elementType : item.type;
  return item;
}

function indexValueNode(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (node && ts.isMappedTypeNode(node)) return node.type;
  if (node && ts.isTypeLiteralNode(node)) return node.members.find(ts.isIndexSignatureDeclaration)?.type;
  return undefined;
}

/** The text of a name as a regular expression that matches that text only. */
function escapedKeyText(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** The expression for one template literal key type (`id_${string}`), or undefined for a shape it cannot state exactly: only `string` holes can. */
function templateKeyExpression(type: ts.TemplateLiteralType): string | undefined {
  if (!type.types.every((hole) => (hole.flags & ts.TypeFlags.String) !== 0)) return undefined;
  return type.texts.map(escapedKeyText).join('[\\s\\S]*');
}

/** The text of a key that a `number` index signature admits: a JSON number written as a property name. */
const NUMBER_KEY_EXPRESSION = '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';

/**
 * The pattern every key of `type` must match, from its index signatures that are keyed by template literal types: undefined when
 * the keys are unrestricted (a `string` key, or no signature), null when a key type cannot be stated as one exact pattern. Declared
 * property names are keys too, so a pattern lets them through.
 */
function indexKeyPattern(checker: ts.TypeChecker, type: ts.Type, declaredNames: readonly string[]): string | null | undefined {
  const expressions: string[] = [];
  let numbered = false;
  for (const { keyType } of checker.getIndexInfosOfType(type)) {
    if ((keyType.flags & ts.TypeFlags.String) !== 0) return undefined;
    if ((keyType.flags & ts.TypeFlags.Number) !== 0) numbered = true;
    if ((keyType.flags & ts.TypeFlags.StringLike) === 0) continue;
    const expression = (keyType.flags & ts.TypeFlags.TemplateLiteral) !== 0 ? templateKeyExpression(keyType as ts.TemplateLiteralType) : undefined;
    if (expression === undefined) return null;
    expressions.push(expression);
  }
  if (expressions.length === 0) return undefined;
  return `^(?:${[...expressions, ...(numbered ? [NUMBER_KEY_EXPRESSION] : []), ...declaredNames.map(escapedKeyText)].join('|')})$`;
}

/**
 * What an `AdditionalProperties<V>` tag says about the other keys: `false` when none is allowed, the descriptor of V
 * when they are values of type V (converted like the values of an index signature), `true` when V is `unknown` or `any`
 * (the values are copied as they are), and `undefined` when the object has no such tag.
 */
function additionalPropertiesFromTags(
  constraints: readonly ModelConstraint[],
): boolean | ModelConversionDescriptor | undefined {
  const additional = constraints.find((constraint) => constraint.kind === 'additionalProperties');
  if (!additional || additional.kind !== 'additionalProperties') return undefined;
  const schema = additional.schema;
  if (schema === false) return false;
  if (typeof schema === 'object' && schema !== null && 'kind' in schema) {
    const kind = (schema as { readonly kind: string }).kind;
    if (kind === 'never' || kind === 'undefined') return false;
    if (kind !== 'unknown' && kind !== 'any') return schema as ModelConversionDescriptor;
  }
  return true;
}

function withMetadata(
  descriptor: ModelConversionDescriptor,
  metadata: TagMetadata,
): RichModelConversionDescriptor {
  if (!metadata.validations.length && !metadata.serde && !metadata.constraints.length && !metadata.date) {
    return descriptor as RichModelConversionDescriptor;
  }
  return {
    ...descriptor,
    ...(metadata.validations.length ? { validations: metadata.validations } : {}),
    ...(metadata.serde ? { serde: metadata.serde } : {}),
    ...(metadata.constraints.length ? { constraints: metadata.constraints } : {}),
    ...(metadata.date ? { date: true } : {}),
  } as RichModelConversionDescriptor;
}

/** The one tag key a union declares: on the union itself, or on its variants when `| null` keeps the tag inside a member. */
function unionTag(
  context: TypeAnalysisContext,
  at: ts.Node,
  onUnion: { readonly key: string; readonly defaultType?: ts.Type } | undefined,
  onVariants: readonly ({ readonly key: string; readonly defaultType?: ts.Type } | undefined)[],
): { readonly key: string; readonly defaultType?: ts.Type } | undefined {
  const tags = [...(onUnion === undefined ? [] : [onUnion]), ...onVariants.filter((tag): tag is NonNullable<typeof tag> => tag !== undefined)];
  const keys = new Set(tags.map((tag) => tag.key));
  if (keys.size > 1) throw diagnostic(context.sourceFile, at, '1051', `Conflicting Discriminator tags: ${[...keys].map((key) => `'${key}'`).join(' and ')}. A union has one tag key.`);
  const defaultType = tags.find((tag) => tag.defaultType !== undefined)?.defaultType;
  return tags[0] === undefined ? undefined : { key: tags[0].key, ...(defaultType ? { defaultType } : {}) };
}

function discriminatorPlacementMessage(context: TypeAnalysisContext, resolved: string): string {
  return `Discriminator on the model value requires a union of two or more object types, but ${context.name} resolves to ${resolved}.`;
}

function isObjectLikeVariant(descriptor: ModelConversionDescriptor): boolean {
  return descriptor.kind === 'object' || descriptor.kind === 'reference' || descriptor.kind === 'generated-model';
}

/** The required literal values of `key` on a variant type: its tag values, or undefined when the key is missing, optional or not a literal. */
function requiredLiteralValues(checker: ts.TypeChecker, variant: ts.Type, key: string, at: ts.Node): DiscriminatorValue[] | undefined {
  const property = checker.getPropertyOfType(variant, key);
  if (!property || (property.flags & ts.SymbolFlags.Optional) !== 0) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(property, at);
  const members = type.isUnion() ? type.types : [type];
  const values: DiscriminatorValue[] = [];
  for (const member of members) {
    if (member.flags & ts.TypeFlags.StringLiteral) values.push((member as ts.StringLiteralType).value);
    else if (member.flags & ts.TypeFlags.NumberLiteral) values.push((member as ts.NumberLiteralType).value);
    else if (member.flags & ts.TypeFlags.BooleanLiteral) values.push(checker.typeToString(member) === 'true');
    else return undefined;
  }
  return values;
}

/**
 * The tag table of a union that declares its key: each variant's required literal values at `key`, in the variant order of the
 * descriptor. A variant that is no object (`null`, a scalar, an array or a tuple) carries no values: the JSON type selects it. An
 * object-like variant without a required literal, or a value two variants share, stops with RUNM1087.
 */
function declaredTagTable(
  checker: ts.TypeChecker,
  { key, defaultType }: { readonly key: string; readonly defaultType?: ts.Type },
  entries: readonly { readonly type: ts.Type; readonly descriptor: ModelConversionDescriptor }[],
  context: TypeAnalysisContext,
  at: ts.Node,
): UnionDiscriminator {
  if (entries.filter((entry) => isObjectLikeVariant(entry.descriptor)).length < 2) {
    throw diagnostic(context.sourceFile, at, '1051', discriminatorPlacementMessage(context, entries.map((entry) => untaggedTypeText(checker, entry.type)).join(' | ')));
  }
  const nameOf = ({ type, descriptor }: (typeof entries)[number]): string => descriptor.kind === 'reference' ? descriptor.name : untaggedTypeText(checker, type);
  // The declared default is the variant that is the `Default` type; it alone may lack the key, and it must not carry it.
  const defaultIndex = defaultType === undefined ? undefined : entries.findIndex(({ type }) => type === defaultType
    || (checker.isTypeAssignableTo(type, defaultType) && checker.isTypeAssignableTo(defaultType, type)));
  if (defaultType !== undefined && (defaultIndex === undefined || defaultIndex < 0)) {
    throw diagnostic(context.sourceFile, at, '1051', `Discriminator<'${key}', ${checker.typeToString(defaultType)}> in ${context.name} names a default that is not a variant of the union. Name one of its variants: ${entries.map(nameOf).join(', ')}.`);
  }
  if (defaultIndex !== undefined && !isObjectLikeVariant(entries[defaultIndex].descriptor)) {
    throw diagnostic(context.sourceFile, at, '1051', `Discriminator<'${key}', ${checker.typeToString(defaultType!)}> in ${context.name} names a default that is no object. The default is the object variant that has no tag; a scalar, array or null variant is chosen by its JSON type, so name an object variant or remove the default.`);
  }
  if (defaultIndex !== undefined && checker.getPropertyOfType(entries[defaultIndex].type, key)) {
    throw diagnostic(context.sourceFile, at, '1051', `The default variant ${nameOf(entries[defaultIndex])} of Discriminator<'${key}'> in ${context.name} has a "${key}" property itself. The default is the variant that has no tag, so name another variant or rename the property.`);
  }
  const owners = new Map<DiscriminatorValue, string>();
  const variants = entries.map((entry, position) => {
    const { type, descriptor } = entry;
    // A scalar, array or tuple beside the objects converts by its JSON type, as the default does; only an object-like variant needs the key.
    if (descriptor.kind === 'null' || descriptor.kind === 'undefined' || position === defaultIndex || !isObjectLikeVariant(descriptor)) return { values: [] };
    const name = nameOf(entry);
    const values = requiredLiteralValues(checker, type, key, at);
    if (!values) {
      throw diagnostic(context.sourceFile, at, '1087', `Union variant ${name} in ${context.name} has no required literal property "${key}", the tag key that Discriminator<'${key}'> declares. Give ${name} a required "${key}" property with a literal type, such as \`${key}: 'a'\`.`);
    }
    for (const value of values) {
      const owner = owners.get(value);
      if (owner !== undefined) {
        throw diagnostic(context.sourceFile, at, '1087', `Union variants ${owner} and ${name} in ${context.name} share the "${key}" value ${JSON.stringify(value)}. Give each variant its own "${key}" value.`);
      }
      owners.set(value, name);
    }
    return { values };
  });
  return { propertyName: key, variants, ...(defaultIndex === undefined ? {} : { defaultVariant: defaultIndex }) };
}

/**
 * Rule: a union of two or more object-like variants declares its tag key. Golem never finds the key in the variants, so an
 * untagged union stops here with RUNM1080, at every position, whatever the variants convert. A variant with its own serde pair is no object,
 * a union of types that only default library files declare (`ArrayBuffer | SharedArrayBuffer`) is not the user's union, and a union in
 * a controller DTO class field (`context.dto`) is Nest's own to document: no model converts it.
 */
function rejectUntaggedObjectUnion(
  checker: ts.TypeChecker,
  entries: readonly { readonly type: ts.Type; readonly descriptor: ModelConversionDescriptor }[],
  context: TypeAnalysisContext,
  at: ts.Node,
  isDefaultLibraryFile: (file: ts.SourceFile) => boolean,
): void {
  const declaredByLibrary = (type: ts.Type): boolean => {
    const declarations = type.getSymbol()?.declarations ?? [];
    return declarations.length > 0 && declarations.every((declaration) => isDefaultLibraryFile(declaration.getSourceFile()));
  };
  if (context.dto || entries.every(({ type }) => declaredByLibrary(type))) return;
  const objects = entries.filter(({ descriptor }) => isObjectLikeVariant(descriptor) && (descriptor as { readonly serde?: unknown }).serde === undefined);
  if (objects.length < 2) return;
  const names = objects.map(({ type, descriptor }) => descriptor.kind === 'reference' ? descriptor.name
    : descriptor.kind === 'generated-model' ? descriptor.id : checker.typeToString(type));
  const sdkModels = objects.flatMap(({ descriptor }) => descriptor.kind === 'generated-model' ? [descriptor.id] : []);
  const defaultHint = sdkModels.length > 0 ? ` For an SDK model that has no such property, name it as the default: \`Discriminator<'kind', ${sdkModels[0]}>\`.` : '';
  throw diagnostic(context.sourceFile, at, '1080', `Union in ${context.name} has ${objects.length} object variants (${names.join(' | ')}) and does not declare its tag key. Give each variant a required literal property such as \`kind: 'a'\`, and add \`& Discriminator<'kind'>\` to the union.${defaultHint}`);
}

/** The type a mapped projection reads its members from: `Customer` in `Pick<Customer, 'name'>` or in `{ [K in 'name']: Customer[K] }`. */
function projectedSourceType(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const aliased = type.aliasTypeArguments?.[0];
  if (aliased) return aliased;
  const template = type.getSymbol()?.declarations?.find(ts.isMappedTypeNode)?.type;
  return template && ts.isIndexedAccessTypeNode(template) ? checker.getTypeFromTypeNode(template.objectType) : undefined;
}

const SHOWN_TEXT_LENGTH = 60;

/** The source text of `node` on one line, cut after SHOWN_TEXT_LENGTH characters. */
function shortenedText(node: ts.Node): string {
  const text = node.getText(node.getSourceFile()).replace(/\s+/g, ' ');
  return text.length > SHOWN_TEXT_LENGTH ? `${text.slice(0, SHOWN_TEXT_LENGTH - 1)}…` : text;
}

export function descriptorBuilder(
  checker: ts.TypeChecker,
  specifications: readonly ModelSpecification[],
  manifestIndex: ManifestIndex,
  validationLevel: GolemProfile['validation'],
  allowAny = false,
  identityRoot: string | undefined,
  allowUnresolved = true,
  /** Name that references to a model and its derived projections use; the model's own name when omitted. */
  nameFor: ((specification: ModelSpecification) => string) | undefined,
  /** Canonical model source files of the job, which have a generated companion; omitted when the analysis emits none. */
  modelSources: ReadonlySet<string> | undefined,
  /** The models-job boundary, for the diagnostic of a field that nests a model this job does not own. */
  boundary: ModelBoundary | undefined,
  /** The first TypeScript error that starts inside a node, for the diagnostic of a type that did not resolve. */
  typeErrorAt: ((node: ts.Node) => string | undefined) | undefined,
  /** Whether a source file is a default library file: a symbol key it declares is the built-in type's own metadata, not a field. */
  isDefaultLibraryFile: (file: ts.SourceFile) => boolean,
  /** How many instances of one generic declaration may be open at once before the walk stops with RUNM1083. */
  maxExpansionDepth = DEFAULT_MAX_EXPANSION_DEPTH,
): {
  (type: ts.Type, context: TypeAnalysisContext, seen?: ReadonlySet<ts.Type>, node?: ts.TypeNode): ModelConversionDescriptor;
  readonly projections: ReadonlyMap<string, ModelConversionDescriptor>;
  /**
   * The model a type with no authored type node stands for, or undefined. It reads the checker and the specifications only, so asking
   * leaves no projection name behind. A phantom tag around a single other member does not hide the model.
   */
  readonly modelOf: (type: ts.Type) => ModelSpecification | undefined;
} {
  const projections = new Map<string, ModelConversionDescriptor>();
  const projectionCache = new Map<ts.Type, Map<string, string>>();
  // Where each projection name was first minted, for the clash diagnostic.
  const projectionSources = new Map<string, string>();
  // The type that minted each projection name. A recursive type that asks for a name another type holds takes a qualified name before its body is read.
  const projectionOwners = new Map<string, ts.Type>();
  const headNames = new Map<ts.Type, Map<string, string>>();
  // Whether a recursive type reads the same as the holder of a plain name, by that name. Kept across `snapshotNames`, so each type is read once for it.
  // The verdicts belong to the holder they were read against: another holder of the name (after a rollback) starts with none.
  const sharesPlainName = new Map<string, { holder: ts.Type; verdicts: Map<ts.Type, boolean> }>();
  // The arguments of the `describe` calls that are open, so a name claim can read the type once under another name.
  const openCalls: Parameters<typeof describeType>[] = [];
  const snapshotNames = (): (() => void) => {
    const copy = <K, V>(source: Map<K, V>, inner: (value: V) => V = (value) => value): Map<K, V> =>
      new Map([...source].map(([key, value]) => [key, inner(value)] as const));
    const saved = {
      projections: copy(projections), cache: copy(projectionCache, (value) => new Map(value)), owners: copy(projectionOwners),
      heads: copy(headNames, (value) => new Map(value)), sources: copy(projectionSources), stems: copy(cycleStems),
    };
    const restore = <K, V>(target: Map<K, V>, source: Map<K, V>): void => { target.clear(); source.forEach((value, key) => target.set(key, value)); };
    return () => {
      restore(projections, saved.projections); restore(projectionCache, saved.cache); restore(projectionOwners, saved.owners);
      restore(headNames, saved.heads); restore(projectionSources, saved.sources); restore(cycleStems, saved.stems);
    };
  };
  const claimHeadName = (type: ts.Type, stem: string, suffix: string): string => {
    const known = headNames.get(type)?.get(suffix);
    if (known !== undefined) return known;
    const free = (name: string): boolean => !modelLocations.has(name) && (projectionOwners.get(name) ?? type) === type;
    const qualifiers = headQualifiers(checker, type);
    const options = [stem, ...qualifiers.map((part) => `${stem}${part}`)];
    let name = options.map((option) => `${option}${suffix}`).find(free);
    // Names that stay equal after qualifying get a number, so every valid program generates.
    for (let number = 2; name === undefined; number += 1) {
      const numbered = `${options[options.length - 1]}${number}${suffix}`;
      if (free(numbered)) name = numbered;
    }
    const plain = `${stem}${suffix}`;
    const setName = (value: string): void => {
      headNames.set(type, (headNames.get(type) ?? new Map<string, string>()).set(suffix, value));
    };
    setName(name);
    // A finished projection of another type holds the plain name: when this type reads the same under its own name, the two share the plain name.
    const owner = projectionOwners.get(plain);
    if (name !== plain && owner !== undefined && owner !== type && projections.has(plain) && !modelLocations.has(plain)) {
      let known = sharesPlainName.get(plain);
      if (known?.holder !== owner) {
        known = { holder: owner, verdicts: new Map<ts.Type, boolean>() };
        sharesPlainName.set(plain, known);
      }
      const { verdicts } = known;
      let shares = verdicts.get(type);
      if (shares === undefined) {
        const restore = snapshotNames();
        describeType(...openCalls[openCalls.length - 1]!);
        const lookup = (projection: string): ModelConversionDescriptor | undefined => projections.get(projection);
        const read = (projection: string): string | undefined => {
          const descriptor = projections.get(projection);
          return descriptor && projectionIdentity(lookup, projection, descriptor);
        };
        shares = read(name) === read(plain);
        verdicts.set(type, shares);
        if (shares) restore();
      }
      if (shares) {
        setName(plain);
        return plain;
      }
    }
    return name;
  };
  const sourceLocation = (at: ts.Node): string => {
    const sourceFile = at.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile));
    return `${displayPath(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}`;
  };
  const modelNames = new Map(
    specifications.map((specification) => [specification.declaration, nameFor?.(specification) ?? specification.name] as const),
  );
  const modelLocations = new Map(specifications.map((specification) =>
    [specification.name, sourceLocation(specification.declaration)] as const));
  const modelNameOf = (declaration: ts.TypeAliasDeclaration): string | undefined => {
    const name = modelNames.get(declaration);
    return name === undefined ? undefined : safeNameHint(name, name);
  };
  const stableIdentityRoot = canonicalFilename(identityRoot ?? commonDirectory(
    specifications.map((specification) => specification.sourceFile.fileName),
  ));
  // The companion of a source file reads the filesystem, so each source file's is computed once.
  // A model's companion is where its imports are written, so every job names a TSerde or TValidation function from the same file.
  const companions = new Map<string, string>(specifications.flatMap((specification) =>
    specification.companionFile === undefined ? [] : [[specification.sourceFile.fileName, specification.companionFile] as const]));
  const companionOf = (sourceFile: string): string => {
    let companion = companions.get(sourceFile);
    if (companion === undefined) {
      companion = companionFilename(boundary, sourceFile);
      companions.set(sourceFile, companion);
    }
    return companion;
  };
  const structuralModels = new Map<ts.Type, ModelSpecification | undefined>();
  const structuralModel = (type: ts.Type): ModelSpecification | undefined => {
    if (structuralModels.has(type)) return structuralModels.get(type);
    const match = uniqueStructuralModel(checker, type, specifications);
    structuralModels.set(type, match);
    return match;
  };

  // A model and a class model end a walk: `describe` returns a reference for each before it reads the body.
  const isModelBoundary = (type: ts.Type): boolean =>
    modelSpecificationForType(checker, type, specifications) !== undefined
    || ((type.flags & ts.TypeFlags.Object) !== 0 && modelSpecificationForClass(checker, type, specifications) !== undefined);
  // The types a type holds that `describe` descends into. It stops where `describe` stops, so a type that reaches
  // itself only through a model is not a cycle: the model is a reference.
  // A variant `A & Discriminator<'k'>` is described as `A`, so the cycle walk holds `A`.
  const heldTypes = (type: ts.Type, location: ts.Node): readonly ts.Type[] => heldWithTags(type, location).map((held) => withoutDiscriminator(checker, held));
  const heldWithTags = (type: ts.Type, location: ts.Node): readonly ts.Type[] => {
    if (type.isUnion()) return type.types;
    if (!isStructured(type) || isModelBoundary(type)) return [];
    if (type.isIntersection() && !isObjectLikeIntersection(checker, type)) {
      return type.types.filter((member) => !isPhantomTagType(checker, member));
    }
    if ((type.flags & ts.TypeFlags.Object) === 0 && !type.isIntersection()) return [];
    if (checker.isTupleType(type) || checker.isArrayType(type)) return checker.getTypeArguments(type as ts.TypeReference);
    if (isDateType(checker, type) || isBrandedDate(checker, type) || primitiveConstructorDescriptor(type) || isPhantomTagType(checker, type)
      || type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return [];
    const held: ts.Type[] = [];
    for (const property of checker.getPropertiesOfType(type)) {
      const valueType = propertyType(checker, property, location);
      if (valueType.getCallSignatures().length === 0) held.push(valueType);
    }
    const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (indexType) held.push(indexType);
    return held;
  };
  // The types that reach themselves and carry a name to give: a type from a type alias that the user wrote, else
  // (an interface or a class has no alias) an object type. The walk keeps the alias types of a cycle, so one name per
  // alias gives the same projection from any entry type.
  const cycleHeads = new Map<ts.Type, boolean>();
  // A generic type that holds itself with a new type argument on each level, such as `interface Box<T> { next?: Box<Box<T>> }`, makes a
  // new type on each level, so no cycle head repeats. The walks count the instances of each generic declaration they are in and stop at the bound.
  // Only an interface, class or type alias of the project with type parameters counts: arrays, tuples, library types and anonymous types do not.
  const activeInstances = new Map<ts.Symbol, ts.Type[]>();
  const enterExpansion = (type: ts.Type, location: ts.Node): (() => void) => {
    const symbol = isStructured(type) ? type.aliasSymbol ?? type.getSymbol() : undefined;
    const declaration = symbol?.declarations?.find((candidate) =>
      (ts.isInterfaceDeclaration(candidate) || ts.isClassDeclaration(candidate) || ts.isTypeAliasDeclaration(candidate))
      && (candidate.typeParameters?.length ?? 0) > 0);
    if (symbol === undefined || declaration === undefined || isDefaultLibraryFile(declaration.getSourceFile())) return () => undefined;
    const instances = activeInstances.get(symbol) ?? [];
    if (instances.includes(type)) return () => undefined;
    if (instances.length >= maxExpansionDepth) {
      const name = symbol.getName();
      throw diagnostic(location.getSourceFile(), location, '1083',
        `The generic type ${name} expands without end: each level holds ${name} with other type arguments, and more than ${maxExpansionDepth} levels are open, so no finite schema describes it. `
        + `Pass the same type arguments back, for example ${name}<T> inside ${name}<T>.`);
    }
    activeInstances.set(symbol, [...instances, type]);
    return () => { activeInstances.set(symbol, instances); };
  };
  // The name each cycle head was given on its first lap.
  const cycleStems = new Map<ts.Type, string>();
  /** The variant types of unions that declare a Discriminator key: the tag in their type is the union's, not a misplaced one. */
  const declaredVariants = new Set<ts.Type>();
  const probeCycles = (root: ts.Type, location: ts.Node): void => {
    const index = new Map<ts.Type, number>();
    const low = new Map<ts.Type, number>();
    const stack: ts.Type[] = [];
    const onStack = new Set<ts.Type>();
    const visitType = (type: ts.Type): void => {
      index.set(type, index.size);
      low.set(type, index.get(type)!);
      stack.push(type);
      onStack.add(type);
      let selfLoop = false;
      for (const held of heldTypes(type, location)) {
        if (held === type) selfLoop = true;
        if (cycleHeads.has(held)) continue;
        if (!index.has(held)) {
          visit(held);
          low.set(type, Math.min(low.get(type)!, low.get(held)!));
        } else if (onStack.has(held)) low.set(type, Math.min(low.get(type)!, index.get(held)!));
      }
      if (low.get(type) !== index.get(type)) return;
      const component: ts.Type[] = [];
      for (let member: ts.Type | undefined; member !== type;) {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      }
      const cyclic = component.length > 1 || selfLoop;
      const aliased = component.filter((member) => userAliasName(member) !== undefined);
      const heads = new Set(!cyclic ? [] : aliased.length > 0 ? aliased : component.filter((member) =>
        (member.flags & ts.TypeFlags.Object) !== 0 && !checker.isArrayType(member) && !checker.isTupleType(member)));
      for (const member of component) cycleHeads.set(member, heads.has(member));
    };
    const visit = (type: ts.Type): void => {
      const leave = enterExpansion(type, location);
      try { visitType(type); } finally { leave(); }
    };
    visit(root);
  };
  const isCycleHead = (type: ts.Type, location: ts.Node): boolean => {
    if (!isStructured(type)) return false;
    if (!cycleHeads.has(type)) probeCycles(type, location);
    return cycleHeads.get(type) === true;
  };

  const rejectUnlessAllowAny = (context: TypeAnalysisContext, kind: 'any' | 'unknown'): void => {
    if (context.allowAny ?? allowAny) return;
    throw diagnostic(
      context.sourceFile,
      context.declaration,
      '1011',
      `Model ${context.name} contains ${kind}. Replace it with a concrete type, or allow it with `
        + `{ allowAny: true } as the model's second type argument (IModel<Fields, { allowAny: true }>) `
        + 'or allowAny: true in golem.yaml.',
    );
  };

  /**
   * The model a type stands for, from the authored type node (`node`), the class that extends a generated base, the alias that declares
   * the model, or the fields it shares. It is the ladder `describeType` climbs and the answer to "is this a model?" for every caller:
   * it reads only the checker and the specifications, so it writes no projection name, owner or cache entry.
   */
  const modelOf = (type: ts.Type, node: ts.TypeNode | undefined, isRoot: boolean, serde: boolean): {
    readonly provenance: ReturnType<typeof fieldProvenance>;
    readonly projection: boolean;
    readonly candidates: readonly ModelSpecification[];
    readonly classMatch: ModelSpecification | undefined;
    readonly model: ModelSpecification | undefined;
  } => {
    const provenance = fieldProvenance(checker, node, specifications);
    const projection = provenance.projection || isPropertyMapping(type);
    const candidates = provenance.models.filter(specification => checker.isTypeAssignableTo(type, specification.fieldsType)
      && checker.isTypeAssignableTo(specification.fieldsType, type));
    const classMatch = isRoot || type.isUnion() || isPropertyMapping(type) || projection
      ? undefined
      : modelSpecificationForClass(checker, type, specifications);
    const projectedStructural = (): ModelSpecification | undefined => {
      const structural = structuralModel(type);
      return structural && !provenance.models.includes(structural) ? structural : undefined;
    };
    // A TSerde over a bigint or a class value converts the whole value by its codec, so the type is no model whatever class it is.
    const serdeValue = serde && (isBigIntValueType(type) || isClassValueType(checker, type));
    const model = serdeValue ? undefined : classMatch ?? (isRoot || type.isUnion() || isPropertyMapping(type) ? undefined
      : projection
        ? projectedStructural()
        : (candidates[0]
          ?? modelSpecificationForType(checker, type, specifications)
          ?? (provenance.models.length > 0 ? structuralModel(type) : undefined)));
    return { provenance, projection, candidates, classMatch, model };
  };

  /** Whether the model being described validates: its own `{ validation }` setting, else the job's. A check golem cannot state stops generation only then. */
  const modelValidates = (context: TypeAnalysisContext): boolean =>
    (specifications.find(specification => specification.declaration === context.declaration)?.validation ?? validationLevel) !== false;

  const describeType = (
    originalType: ts.Type,
    context: TypeAnalysisContext,
    seen: ReadonlySet<ts.Type> = new Set<ts.Type>(),
    node?: ts.TypeNode,
    representation: 'model' | 'wire' = 'model',
    provenanceNode?: ts.TypeNode,
    substitutions: TypeSubstitutions = new Map(),
    nameHint: string = safeNameHint(context.ownerName ?? context.name, 'Model'),
    nameNode?: ts.TypeNode,
  ): ModelConversionDescriptor => {
    node = substituteTypeNode(checker, node, substitutions);
    const instantiated = instantiatedTypeSource(checker, node ?? provenanceNode, substitutions);
    const childNode = instantiated.node;
    const childSubstitutions = instantiated.substitutions;
    const tagContext = {
      checker,
      sourceFile: context.sourceFile,
      identityRoot: stableIdentityRoot,
      importer: companionOf(context.sourceFile.fileName),
      ...(modelSources ? { isModelSource: (filename: string) => modelSources.has(filename) } : {}),
      diagnostic: (tagNode: ts.Node, code: string, message: string) =>
        diagnostic(context.sourceFile, tagNode, code, message),
      describeSchema: (schemaType: ts.Type, schemaNode?: ts.TypeNode) =>
        describe(schemaType, { ...context, exact: false, schemaData: true }, seen, schemaNode, representation, undefined, undefined, nameHint),
    };
    // Analyze checker types even when a child has no corresponding AST node
    // (for example the Date branch of `Date | undefined`). A union variant reads the authored member that names it.
    const analysis = analyzeNode(tagContext, originalType, node ?? nameNode);
    let metadata: InternalTagMetadata = analysis.metadata;
    if (metadata.serde && !metadata.serde.wireDescriptor) {
      const wireDescriptor = describe(metadata.serde.wireType, context, seen, undefined, 'wire', undefined, undefined, nameHint);
      metadata = {
        ...metadata,
        serde: { ...metadata.serde, wireDescriptor },
      };
    }
    const hasTagMetadata = metadata.validations.length > 0
      || metadata.serde !== undefined
      || metadata.constraints.length > 0
      || metadata.date === true
      || metadata.discriminator !== undefined;
    // A Discriminator tag alone leaves the checker's own type: the union keeps its alias, which names a recursive union once.
    const hasBaseTags = metadata.validations.length > 0 || metadata.serde !== undefined || metadata.constraints.length > 0 || metadata.date === true;
    const baseType = stripPhantomIntersection(
      checker,
      hasTagMetadata && hasBaseTags && analysis.baseNode
        && !(checker.getTypeFromTypeNode(analysis.baseNode).flags & ts.TypeFlags.TypeParameter)
        ? checker.getTypeFromTypeNode(analysis.baseNode)
        : originalType,
      metadata,
    );
    const type = baseType;

    if (metadata.constraints.length > 0 && (type.flags & ts.TypeFlags.TypeParameter) === 0) {
      assertConstraintCompatibility(checker, metadata.constraints, type, context, representation);
    }

    if (metadata.validations.length > 0 && (type.flags & ts.TypeFlags.TypeParameter) === 0) {
      assertValidationCompatibility(checker, metadata.validations, type, context);
    }

    // A Discriminator tag names the tag key of a union; a variant of such a union carries the tag only in its type.
    if (metadata.discriminator !== undefined && !type.isUnion() && !declaredVariants.has(originalType)) {
      throw diagnostic(context.sourceFile, node ?? context.declaration, '1051', discriminatorPlacementMessage(context, checker.typeToString(type)));
    }

    // Validate the codec against the projected model type before handling
    // Date as a terminal descriptor.  A tagged Date still has a concrete
    // model-side type, so an incompatible serializer/deserializer must be
    // rejected rather than hidden by the Date shortcut below.
    if (metadata.serde && (type.flags & ts.TypeFlags.TypeParameter) === 0) {
      assertSerdeCompatibility(checker, metadata.serde, type, context);
    }

    // A TSerde codec converts the whole value, so only an intersection that no codec converts is cut here, before the object merge reads it.
    const scalar = metadata.serde ? undefined : scalarIntersectedWithObject(checker, type);
    if (scalar) {
      const where = context.field ? `Field "${context.field}" of ${context.name}` : context.name;
      throw diagnostic(
        context.sourceFile,
        node ?? context.declaration,
        '1085',
        `${where} combines ${scalar} with an object type, and no value is both. Keep one of the two types, or move the object into its own field${scalar === 'bigint' ? ', or declare the bigint with a TSerde pair and no object' : ''}.`,
      );
    }

    // A custom serde can intersect Date with its phantom marker.  The
    // checker then no longer reports the original intersection as Date, but
    // the projected base type still is Date and must remain terminal.
    if (metadata.date || isDateType(checker, type) || isBrandedDate(checker, type)) {
      return withMetadata({ kind: 'date' } as unknown as ModelConversionDescriptor, {
        ...metadata,
        date: true,
      });
    }

    // A global `Temporal` class has the conversion of the runtime's Temporal codec of that name, as if it carried the golem Temporal tag.
    const temporalClass = metadata.serde ? undefined : globalTemporalClass(type);
    if (temporalClass !== undefined) {
      return withMetadata({
        kind: 'class-value',
        typeName: `Temporal.${temporalClass}`,
        serde: { id: `${TEMPORAL_SERDE_PREFIX}Temporal${temporalClass}`, wireDescriptor: { kind: 'string' } },
      } as unknown as ModelConversionDescriptor, metadata);
    }
    // A class instance or bigint has no JSON shape of its own; its TSerde codec is its only conversion.
    if (metadata.serde && isBigIntValueType(type)) {
      return withMetadata({ kind: 'class-value', typeName: 'bigint' } as ModelConversionDescriptor, metadata);
    }
    if (metadata.serde && isClassValueType(checker, type)) {
      return withMetadata({ kind: 'class-value', ...classValueReference(checker, type, context, node ?? context.declaration, stableIdentityRoot, companionOf(context.sourceFile.fileName)) } as ModelConversionDescriptor, metadata);
    }

    const isRoot = node === context.fieldsNode;
    const { provenance, projection, candidates, classMatch, model: localModel } = modelOf(type, node ?? provenanceNode ?? analysis.baseNode, isRoot, metadata.serde !== undefined);
    if (provenance.anonymous) {
      const alias = declaredModelAlias(provenance.anonymous);
      const foreign = alias ? foreignModelReason(alias, boundary) : undefined;
      if (foreign !== undefined) throw diagnostic(context.sourceFile, node ?? context.declaration, '1074', foreign);
      const nested = provenance.anonymous;
      throw diagnostic(nested.getSourceFile(), nested, '1053', `Nested IModel definitions need a named, exported declaration: ${shortenedText(nested)}. Give it its own exported type alias.`);
    }
    if (projection) {
      for (const original of provenance.models) {
        const whole = analyzeNode({ ...tagContext, sourceFile: original.sourceFile }, original.fieldsType, original.fieldsNode).metadata;
        if (whole.serde || whole.validations.length || whole.constraints.length) {
          throw diagnostic(context.sourceFile, node ?? context.declaration, '1055', `Projection of ${original.name} would discard whole-object constraints or serialization. Declare an explicit projected contract.`);
        }
      }
    }
    if (!projection && candidates.length > 1 && !type.isUnion()) {
      throw diagnostic(context.sourceFile, node ?? context.declaration, '1054', 'Model identity is ambiguous after type composition. Use an explicit named model reference.');
    }
    const generatedName = localModel ? modelNames.get(localModel.declaration) : undefined;
    if (generatedName) {
      return withMetadata({
        kind: 'reference',
        name: generatedName,
        ...(!localModel?.emitClass ? { projection: true as const } : {}),
        ...(classMatch ? { construct: true as const, ...(type.getSymbol()?.getName() ? { className: type.getSymbol()!.getName() } : {}) } : {}),
      }, metadata);
    }
    // A type of a golem-mode SDK keeps the SDK's limits and conversions: the root of a model takes the SDK's descriptor, and a field
    // refers to the SDK node. The validators compile once for both, since the compiler writes one function for equal schemas.
    const sdkDescriptor = manifestIndex.sdkDescriptorForType(type, isRoot);
    if (sdkDescriptor) return withMetadata(sdkDescriptor as ModelConversionDescriptor, metadata);
    // A scalar alias of the SDK (`type Currency = string`) is `string` to the checker, so the node names it. Its limits come first, then the field's own.
    const scalarNode = hasBaseTags && analysis.baseNode ? analysis.baseNode : node ?? nameNode;
    const sdkScalar = scalarNode === undefined ? undefined : manifestIndex.sdkScalarDescriptorForNode(checker, scalarNode) as { readonly constraints?: readonly ModelConstraint[] } | undefined;
    if (sdkScalar) return withMetadata({ ...sdkScalar } as ModelConversionDescriptor, { ...metadata, constraints: [...(sdkScalar.constraints ?? []), ...metadata.constraints] });
    if (type.flags & ts.TypeFlags.Any) {
      if (!allowUnresolved && isErrorAny(type)) {
        const at = node ?? context.declaration;
        const cause = typeErrorAt?.(at);
        throw diagnostic(context.sourceFile, at, '1058', `A contract type could not be resolved${cause ? ` (${cause})` : ''}. Fix its declaration or import before generating OpenAPI.`);
      }
      if (!isErrorAny(type)) rejectUnlessAllowAny(context, 'any');
      return withMetadata(isErrorAny(type) ? { kind: 'unknown' } : { kind: 'any' }, metadata);
    }
    if (type.flags & ts.TypeFlags.Unknown) {
      // A tag argument is schema data, not a field type, so `Not<unknown>` stays valid.
      if (!context.schemaData) rejectUnlessAllowAny(context, 'unknown');
      return withMetadata({ kind: 'unknown' }, metadata);
    }
    if (type.flags & ts.TypeFlags.Never) return withMetadata({ kind: 'never' }, metadata);
    if (type.flags & ts.TypeFlags.String) return withMetadata({ kind: 'string' }, metadata);
    if (type.flags & ts.TypeFlags.Number) return withMetadata({ kind: 'number' }, metadata);
    if (type.flags & ts.TypeFlags.Boolean) return withMetadata({ kind: 'boolean' }, metadata);
    if (type.flags & ts.TypeFlags.BigInt) return withMetadata({ kind: 'bigint' }, metadata);
    if (type.flags & ts.TypeFlags.Null) return withMetadata({ kind: 'null' }, metadata);
    if (type.flags & ts.TypeFlags.Undefined) return withMetadata({ kind: 'undefined' }, metadata);
    if (type.flags & ts.TypeFlags.StringLiteral) {
      return withMetadata({ kind: 'literal', value: String((type as ts.StringLiteralType).value) }, metadata);
    }
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      return withMetadata({ kind: 'literal', value: (type as ts.NumberLiteralType).value }, metadata);
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return withMetadata({ kind: 'literal', value: checker.typeToString(type) === 'true' }, metadata);
    }
    if (type.flags & ts.TypeFlags.TemplateLiteral) return withMetadata({ kind: 'string' }, metadata);
    const objectLikeIntersection = isObjectLikeIntersection(checker, type);
    const sequence = checker.isTupleType(type) || checker.isArrayType(type);
    const objectShape = !type.isUnion() && !(type.isIntersection() && !objectLikeIntersection) && !sequence
      && ((type.flags & ts.TypeFlags.Object) !== 0 || objectLikeIntersection)
      && !primitiveConstructorDescriptor(type) && type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0;
    // A type that reaches itself becomes a named projection of any shape: a projected object of a model, and a union,
    // array, tuple or object that holds itself with no model between.
    const recursive = !isRoot && isCycleHead(type, context.declaration);
    let projectionName: string | undefined;
    if ((projection && objectShape && !isRoot) || recursive) {
      const nameAt = node ?? nameNode;
      // A cycle head keeps the name its first lap gave it, so a declared name that is not a plain identifier (non-ASCII) still ends the cycle,
      // and a projection that holds itself, such as `Partial<Cfg>` inside `Cfg`, does not take a longer owner-and-field name on each lap.
      const declaredHead = recursive && !projection;
      let stem = recursive ? cycleStems.get(type) : undefined;
      if (stem === undefined) {
        stem = safeNameHint((declaredHead ? userAliasName(type) ?? declaredTypeName(type) : undefined) ?? projectionBaseName(checker, nameAt, modelNameOf, nameHint), nameHint);
        if (recursive) cycleStems.set(type, stem);
      }
      const suffix = policySuffix({ exact: context.exact, allowAny: context.allowAny ?? allowAny, representation });
      // A projection whose keys read like the keys of the plain name's holder (`first-name` and `firstName`) takes the first free number.
      const readsAlike = (name: string): boolean => {
        const holder = projectionOwners.get(name);
        return holder !== undefined && holder !== type && keysReadAlike(checker, holder, type, context.declaration);
      };
      let candidate = recursive ? claimHeadName(type, stem, suffix) : `${stem}${suffix}`;
      if (!recursive && readsAlike(candidate)) {
        let number = 2;
        while (readsAlike(`${stem}${number}${suffix}`)) number += 1;
        candidate = `${stem}${number}${suffix}`;
      }
      if (!isProjectionName(candidate)) throw new Error(`Internal error: projection name "${candidate}" is not a plain identifier.`);
      const here = sourceLocation(nameAt ?? context.declaration);
      const modelLocation = modelLocations.get(candidate);
      if (modelLocation) {
        throw diagnostic(context.sourceFile, nameAt ?? context.declaration, '1059',
          `Projection name ${candidate} is used by a projection and a model: ${here} and ${modelLocation}. Rename one of them, or declare a named type alias for the projection.`);
      }
      const policy = `${context.exact}:${context.allowAny ?? allowAny}:${representation}:${candidate}`;
      const cached = projectionCache.get(type) ?? new Map<string, string>();
      projectionName = cached.get(policy);
      if (projectionName) return { kind: 'reference', name: projectionName, projection: true };
      projectionName = candidate;
      cached.set(policy, projectionName);
      projectionCache.set(type, cached);
      if (!projectionOwners.has(candidate)) projectionOwners.set(candidate, type);
      if (!projectionSources.has(candidate)) projectionSources.set(candidate, here);
    }
    if ((sequence || objectShape) && seen.has(type) && !projectionName) {
      throw diagnostic(context.sourceFile, node ?? context.declaration, '1056', 'Recursive anonymous object conversion needs a named model or projected type.');
    }
    const shape = (seen: ReadonlySet<ts.Type>): ModelConversionDescriptor => {
      if (type.isUnion()) {
        const declaredTag = unionTag(
          context,
          node ?? context.declaration,
          metadata.discriminator === undefined ? undefined : { key: metadata.discriminator, ...(metadata.discriminatorDefault ? { defaultType: metadata.discriminatorDefault } : {}) },
          type.types.map((variant) => checkerDiscriminator(tagContext, variant)),
        );
        if (declaredTag !== undefined) for (const variant of type.types) declaredVariants.add(variant);
        const variantNaming = unionVariantNaming(checker, node, type.types, context.declaration, declaredTag?.key);
        const entries = type.types.map((variant) => ({
          type: variant,
          descriptor: describe(variant, context, seen, undefined, representation, node ?? provenanceNode, childSubstitutions, `${nameHint}${variantNaming.get(variant)?.part ?? ''}`, variantNaming.get(variant)?.node),
        }));
        // Checker member order differs between TypeScript backends and runs; output must not.
        entries.sort((left, right) => compareText(canonicalDescriptorKey(left.descriptor), canonicalDescriptorKey(right.descriptor)));
        if (declaredTag === undefined) rejectUntaggedObjectUnion(checker, entries, context, node ?? context.declaration, isDefaultLibraryFile);
        const variants = entries.map((entry) => entry.descriptor);
        const descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }> = {
          kind: 'union',
          variants,
          ...(declaredTag === undefined ? {} : { discriminator: declaredTagTable(checker, declaredTag, entries, context, node ?? context.declaration) }),
        };
        rejectAmbiguousGeneratedModelUnion(descriptor, context);
        return withMetadata(descriptor, metadata);
      }
      if (type.isIntersection() && !objectLikeIntersection) {
        // A member that the whole intersection equals is the type, as `TCat[]` in `TPet[] & TCat[]` when a derived model narrows a base field;
        // it is described with the authored node that names it, so its items keep their model.
        const authored = node ? checker.getTypeFromTypeNode(node) : undefined;
        const whole = type.types.find(member => member === authored && checker.isTypeAssignableTo(member, type))
          ?? type.types.find(member => checker.isTypeAssignableTo(member, type));
        if (whole) {
          const named = whole === authored;
          return withMetadata(describe(whole, context, seen, named ? node : undefined, representation, named ? provenanceNode : undefined, substitutions, nameHint, nameNode), metadata);
        }
        return withMetadata({
          kind: 'intersection',
          variants: type.types.map((variant) => describe(variant, context, seen, undefined, representation, undefined, undefined, nameHint)),
        }, metadata);
      }
      if (checker.isTupleType(type)) {
        const sequenceSeen = new Set(seen).add(type);
        const reference = tupleTarget(type);
        const arguments_ = checker.getTypeArguments(reference);
        const flags: readonly ts.ElementFlags[] = ts.typeReferenceTarget(reference)?.elementFlags ?? [];
        const allowsUndefined = (itemNode: ts.TypeNode): boolean => {
          const substituted = substituteTypeNode(checker, itemNode, childSubstitutions) ?? itemNode;
          if (ts.isParenthesizedTypeNode(substituted)) return allowsUndefined(substituted.type);
          if (ts.isUnionTypeNode(substituted)) return substituted.types.some(allowsUndefined);
          const declared = checker.getTypeFromTypeNode(substituted);
          const containsUndefined = (candidate: ts.Type): boolean =>
            (candidate.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
            || (candidate.isUnion() && candidate.types.some(containsUndefined));
          return containsUndefined(declared);
        };
        const describeItem = (item: ts.Type, index: number): ModelConversionDescriptor => {
          const itemNode = tupleElementNode(childNode, index);
          const descriptor = describe(item, context, sequenceSeen, itemNode, representation, undefined, childSubstitutions, nameHint, tupleElementNode(nameNode, index));
          // A checker's indexed access type adds undefined for an optional tuple
          // slot. Preserve it only when the authored element admits undefined;
          // the optional marker already represents an absent slot.
          if ((flags[index] ?? 0) & ts.ElementFlags.Optional
            && itemNode && !allowsUndefined(itemNode) && descriptor.kind === 'union') {
            const variants = descriptor.variants.filter(variant => variant.kind !== 'undefined');
            if (variants.length === 1 && variants[0]) return variants[0];
            return { ...descriptor, variants };
          }
          return descriptor;
        };
        const restIndex = flags.findIndex((flag) =>
          (flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0,
        );
        if (restIndex >= 0) {
          const restType = arguments_[restIndex];
          if (!restType) {
            throw diagnostic(context.sourceFile, context.declaration, '1021', `Tuple rest element in ${context.name} must be a concrete array type.`);
          }
          if ((restType.flags & ts.TypeFlags.TypeParameter) !== 0) {
            throw diagnostic(context.sourceFile, context.declaration, '1021', `Tuple rest element in ${context.name} cannot be an unresolved generic variadic.`);
          }
          // The schema of a tuple states a fixed element after its rest element as one `anyOf` of the rest and the fixed types, which accepts them out of order.
          if (modelValidates(context) && restIndex < arguments_.length - 1) {
            const where = context.field ? `Field "${context.field}" of ${context.name}` : context.name;
            throw diagnostic(context.sourceFile, node ?? context.declaration, '1021',
              `${where} has fixed elements after its rest element, which a JSON Schema cannot validate in order. Move the fixed elements before the rest element, or set \`{ validation: false }\` on the model.`);
          }
          const items = arguments_.flatMap((item, index) => index === restIndex
            ? []
            : [describeItem(item, index)]);
          const optionalIndex = flags
            .map((flag, index) => ({ flag, index }))
            .filter(({ index }) => index !== restIndex)
            .find(({ flag }) => (flag & ts.ElementFlags.Optional) !== 0);
          const optionalFrom = optionalIndex
            ? (optionalIndex.index > restIndex ? optionalIndex.index - 1 : optionalIndex.index)
            : undefined;
          return withMetadata({
            kind: 'tuple',
            ...(isReadonlySequenceType(checker, type) ? { isReadonly: true as const } : {}),
            items,
            rest: { index: restIndex, item: describe(restType, context, sequenceSeen, tupleElementNode(childNode, restIndex), representation, undefined, childSubstitutions, nameHint, tupleElementNode(nameNode, restIndex)) },
            ...(optionalFrom === undefined ? {} : { optionalFrom }),
          } as TupleConversionDescriptor, metadata);
        }
        const optionalIndex = flags.findIndex((flag) => (flag & ts.ElementFlags.Optional) !== 0);
        return withMetadata({
          kind: 'tuple',
          ...(isReadonlySequenceType(checker, type) ? { isReadonly: true as const } : {}),
          items: arguments_.map(describeItem),
          ...(optionalIndex < 0 ? {} : { optionalFrom: optionalIndex }),
        }, metadata);
      }
      if (checker.isArrayType(type)) {
        const sequenceSeen = new Set(seen).add(type);
        const [item] = checker.getTypeArguments(type as ts.TypeReference);
        const arrayNode = childNode && ts.isTypeOperatorNode(childNode)
          && childNode.operator === ts.SyntaxKind.ReadonlyKeyword
          ? childNode.type
          : childNode;
        return withMetadata({
          kind: 'array',
          ...(isReadonlySequenceType(checker, type) ? { isReadonly: true as const } : {}),
          item: describe(item ?? checker.getAnyType(), context, sequenceSeen, arrayNode && ts.isArrayTypeNode(arrayNode) ? arrayNode.elementType : typeArgumentNode(arrayNode, 0), representation, undefined, childSubstitutions, nameHint, arrayItemNameNode(nameNode)),
        }, metadata);
      }
      if ((type.flags & ts.TypeFlags.Object) || objectLikeIntersection) {
        const primitiveConstructor = primitiveConstructorDescriptor(type);
        if (primitiveConstructor) return withMetadata(primitiveConstructor, metadata);
        const collection = mapOrSetName(type);
        if (collection) {
          const where = context.field ? `Field "${context.field}"${context.dto ? '' : ` of ${context.name}`}` : `Type ${context.name}`;
          // A decorated DTO field that states its own schema never reaches here, and the property loop below stops an undecorated one
          // with the advice to decorate it; any other Map or Set in a DTO is out of a decorator's reach and has no schema to write.
          if (context.dto) {
            throw diagnostic(context.sourceFile, node ?? context.declaration, '1086', mapOrSetDtoMessage(where, collection, false));
          }
          throw diagnostic(context.sourceFile, node ?? context.declaration, '1004',
            `${where} is a ${collection}, which golem cannot represent. Use a Record or an array.`);
        }
        if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
          if (!validationLevel) return withMetadata({ kind: 'unknown' }, metadata);
          throw diagnostic(context.sourceFile, context.declaration, '1004', `Callable or constructible types cannot be represented by ${context.name}.`);
        }
        // An object breaks any sequence cycle through it: its own revisit is a projection reference or the 1056 diagnostic.
        const nextSeen = new Set([...seen].filter((entry) => !checker.isArrayType(entry) && !checker.isTupleType(entry)));
        nextSeen.add(type);
        // Keep discovered field names as data until the generation diagnostic
        // rejects unsupported Object.prototype collisions; a normal object
        // would invoke the legacy setter for an own `__proto__` key.
        const properties: Record<string, ModelConversionDescriptor> = Object.create(null);
        const required: string[] = [];
        // The generated base of an app class is a stub of its model in the analysis program, so a projection of the class reads
        // the members of the model. An SDK base is real and also declares type-only brand members, which no projection takes.
        const projectedSource = projection && isPropertyMapping(type) ? projectedSourceType(checker, type) : undefined;
        const sourceObject = projectedSource && (projectedSource.flags & ts.TypeFlags.Object) !== 0 ? projectedSource : undefined;
        const members: { readonly name: string; readonly property: ts.Symbol; readonly absentFromSource: boolean }[] = [];
        for (const mapped of checker.getPropertiesOfType(type)) {
          const name = mapped.getName();
          if (sourceObject && isGeneratedBrandKey(checker, mapped)) continue;
          // A tag is type-only: a variant `A & B & Discriminator<'k'>` has the tag key beside its fields, and the key is no field.
          if (isGolemTagKey(checker, mapped)) continue;
          if (isSymbolKeyedProperty(checker, mapped) && isDefaultLibraryProperty(mapped, isDefaultLibraryFile)) continue;
          members.push({ name, property: mapped, absentFromSource: sourceObject !== undefined && !sourceObject.getProperty(name) });
        }
        // A model defined by a mapped type over its own class has no members: the base of the class is a stub of this very model.
        if (sourceObject && modelSpecificationForClass(checker, sourceObject, specifications)?.declaration === context.declaration && !context.schemaData && members.length === 0) {
          throw diagnostic(
            context.sourceFile,
            node ?? context.declaration,
            '1058',
            `${context.name} maps over its own class ${checker.typeToString(sourceObject!)}, whose members are generated from ${context.name}, so golem finds no members in it. Declare the fields in ${context.name}.`,
          );
        }
        for (const { name, property, absentFromSource } of members) {
          const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
          const isMethod = (property.flags & ts.SymbolFlags.Method) !== 0
            || property.declarations?.some(declaration => ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) === true;
          if (!context.schemaData && !isMethod) {
            assertNoSymbolKey(checker, property, `Model ${context.name}`, context.sourceFile, node ?? context.declaration);
            assertSupportedModelFieldName(name);
          }
          if (context.dto && isMethod) continue;
          const valueType = propertyType(checker, property, context.declaration);
          // A member the source type lacks makes the checker's picked type `unknown`; the field is not typed unknown, so `allowAny` is no fix.
          // A string index signature holds the member, and then the field is really typed by it.
          if (absentFromSource && !checker.getIndexTypeOfType(sourceObject!, ts.IndexKind.String) && !context.schemaData && (valueType.flags & ts.TypeFlags.Unknown) !== 0 && !(context.allowAny ?? allowAny)) {
            throw diagnostic(
              context.sourceFile,
              node ?? context.declaration,
              '1058',
              `Field "${name}" is picked from ${checker.typeToString(sourceObject!)}, which has no member "${name}". Fix the key, or the import of the type that declares it.`,
            );
          }
          if (valueType.getCallSignatures().length > 0) {
            if (!validationLevel) {
              properties[name] = { kind: 'unknown' };
              if (!optional) required.push(name);
              continue;
            }
            throw diagnostic(
              context.sourceFile,
              property.valueDeclaration ?? context.declaration,
              '1004',
              `Field "${name}" is callable and cannot be represented by ${context.name}.`,
            );
          }
          // A DTO field with a written Swagger schema is an open object: the schema is the Swagger overlay's to state, and a Map has no field of its own.
          // An optional field has `undefined` in its type; a `null` member makes a different schema, which this shortcut does not write.
          const present = valueType.isUnion() ? valueType.types.filter(member => (member.flags & ts.TypeFlags.Undefined) === 0) : [valueType];
          if (context.dto && present.length === 1 && mapOrSetName(present[0]!) && carriesExplicitSwaggerSchema(property)) {
            properties[name] = { kind: 'object', properties: {}, required: [], additionalProperties: true };
            if (!optional) required.push(name);
            continue;
          }
          const propertyNode = authoredPropertyTypeNode(childNode, name) ?? propertyTypeNode(checker, property, valueType);
          if (context.dto && present.length === 1 && isClassProperty(property)) {
            const collection = mapOrSetName(present[0]!);
            if (collection) {
              throw diagnostic(context.sourceFile, propertyNode ?? context.declaration, '1086', mapOrSetDtoMessage(`Field "${name}"`, collection, true));
            }
          }
          const described = describe(
            valueType,
            { ...context, field: name },
            nextSeen,
            propertyNode,
            representation,
            propertyNode
              ?? (isPropertyMapping(type) ? node ?? provenanceNode : undefined),
            childSubstitutions,
            `${projectionName ?? nameHint}${pascalIdentifier(name) ?? 'Field'}`,
          );
          properties[name] = described;
          if (!optional) required.push(name);
        }
        // The members kept above exclude the brand keys of an SDK base; a readonly modifier counts only for a kept member.
        const memberNames = new Set(members.map(member => member.name));
        const readonlyProperties = readonlyPropertyNames(checker, type).filter(name => memberNames.has(name));
        const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
        // One `additionalProperties` value describes every extra key, so signatures keyed by templates need one value type.
        // Two value types are one when each is assignable to the other: `{ x: number }` written twice is two type objects.
        // A plain `string` signature beside a template one also describes the template's keys, so its value type joins the comparison.
        const templateValueTypes = checker.getIndexInfosOfType(type)
          .filter(({ keyType }) => (keyType.flags & ts.TypeFlags.TemplateLiteral) !== 0).map(({ valueType }) => valueType);
        if (templateValueTypes.length > 0 && indexType) templateValueTypes.push(indexType);
        if (templateValueTypes.some((valueType) => !checker.isTypeAssignableTo(valueType, templateValueTypes[0]!) || !checker.isTypeAssignableTo(templateValueTypes[0]!, valueType))) {
          const where = context.field ? `Field "${context.field}" of ${context.name}` : context.name;
          throw diagnostic(context.sourceFile, node ?? context.declaration, '1004',
            `${where} has index signatures of different value types, which golem cannot state as one value type. Give them one value type, or use one index signature.`);
        }
        const taggedAdditional = indexType ? undefined : additionalPropertiesFromTags(metadata.constraints);
        // The key pattern is a validation rule: with validation off nothing states it, so no key type stops generation for it.
        const keyPattern = indexType && modelValidates(context) ? indexKeyPattern(checker, type, [...memberNames]) : undefined;
        if (keyPattern === null) {
          const where = context.field ? `Field "${context.field}" of ${context.name}` : context.name;
          throw diagnostic(context.sourceFile, node ?? context.declaration, '1004',
            `${where} is keyed by a template literal type that golem cannot state as a key pattern. Use string-only holes, such as \`id_\${string}\`, or a plain string key.`);
        }
        const keyConstraint: ModelConstraint[] = keyPattern === undefined ? [] : [{
          kind: 'propertyNames',
          schema: { kind: 'string', constraints: [{ kind: 'pattern', value: keyPattern }] },
        }];
        const descriptor = withMetadata({
          kind: 'object',
          ...(projection ? { projection: true as const } : {}),
          ...(readonlyProperties.length ? { readonlyProperties } : {}),
          properties,
          required,
          additionalProperties: indexType
            ? describe(indexType, context, nextSeen, indexValueNode(childNode), representation, undefined, childSubstitutions, `${projectionName ?? nameHint}Value`)
            : taggedAdditional !== undefined
              ? taggedAdditional
              : !context.exact,
          // Only an explicit tag that admits extra keys declares them as data; `exact: false` leaves an object open by default.
          ...(taggedAdditional !== undefined && taggedAdditional !== false ? { additionalPropertiesDeclared: true as const } : {}),
        }, keyConstraint.length ? { ...metadata, constraints: [...metadata.constraints, ...keyConstraint] } : metadata);
        return descriptor;
      }
      if (!validationLevel) return withMetadata({ kind: 'unknown' }, metadata);
      throw diagnostic(
        context.sourceFile,
        context.declaration,
        '1003',
        `Unsupported TypeScript type in ${context.name}: ${checker.typeToString(type)}`,
      );
    };
    // A named recursive type is described once, apart from the type that reached it, so its body is the same from any entry.
    const described = shape(projectionName && !projection ? new Set<ts.Type>() : seen);
    if (!projectionName) return described;
    const existing = projections.get(projectionName);
    if (existing) {
      const lookup = (name: string): ModelConversionDescriptor | undefined => projections.get(name);
      if (projectionIdentity(lookup, projectionName, existing) !== projectionIdentity(lookup, projectionName, described)) {
        const nameAt = node ?? nameNode ?? context.declaration;
        throw diagnostic(context.sourceFile, nameAt, '1059',
          `Projection name ${projectionName} is used by two different types: ${projectionSources.get(projectionName)} and ${sourceLocation(nameAt)}. Rename one of the two types; a distinct type alias name also works.`);
      }
      return { kind: 'reference', name: projectionName, projection: true };
    }
    projections.set(projectionName, described);
    return { kind: 'reference', name: projectionName, projection: true };
  };
  const describe: typeof describeType = (originalType, context, ...rest) => {
    const leave = enterExpansion(originalType, context.declaration);
    openCalls.push([originalType, context, ...rest]);
    try { return describeType(originalType, context, ...rest); } finally { openCalls.pop(); leave(); }
  };
  const modelOfType = (type: ts.Type): ModelSpecification | undefined => {
    const members = type.isIntersection() ? type.types.filter((member) => !isPhantomTagType(checker, member)) : [];
    return modelOf(members.length === 1 ? members[0]! : type, undefined, false, carriesSerdeTag(checker, type)).model;
  };
  return Object.assign(describe, { projections, modelOf: modelOfType });
}
