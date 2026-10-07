import path from 'node:path';
import { fieldProvenance, isPropertyMapping, isReadonlySequenceType, readonlyPropertyNames, instantiatedTypeSource, substituteTypeNode, authoredPropertyTypeNode, type TypeSubstitutions } from './projections.js';
import * as ts from '../typescript-ns.js';
import { declaredModelAlias, diagnostic, foreignModelReason, modelSpecificationForClass, propertyType, resolveSymbol } from './symbols.js';
import { projectionIdentity } from './graph.js';
import { isProjectionName, pascalIdentifier, policySuffix, projectionBaseName, safeNameHint, unionVariantNaming } from './projection-names.js';
import { commonDirectory, canonicalFilename, type ModelBoundary } from './project.js';
import { packageSpecifier } from './package-specifier.js';
import { assertSupportedModelFieldName, canonicalDescriptorKey, compareText } from '../schema.js';
import type {
  ModelConversionDescriptor,
  TupleConversionDescriptor,
} from '../model-source-emitter.js';
import type { ManifestIndex } from './provenance.js';
import type { ModelSpecification, TypeAnalysisContext } from './models.js';
import {
  analyzeNode,
  isDateType,
  mergeTagMetadata,
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

function isUserValueDeclaration(declaration: ts.Node | undefined): boolean {
  const file = declaration?.getSourceFile?.();
  return file !== undefined && file.isDeclarationFile === false;
}

function isAmbientOrGlobalSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) return true;
  const declarations = symbol.declarations ?? [];
  if (isUserValueDeclaration(symbol.valueDeclaration) || declarations.some(isUserValueDeclaration)) {
    return false;
  }
  return true;
}

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

function propertyTypeNode(checker: ts.TypeChecker, property: ts.Symbol): ts.TypeNode | undefined {
  const roots = checker.getRootSymbols(property);
  const root = roots.length === 1 ? roots[0] : undefined;
  const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? root?.valueDeclaration ?? root?.declarations?.[0];
  return declaration && (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration))
    ? declaration.type
    : undefined;
}

function tupleTarget(type: ts.Type): ts.TypeReference {
  return type as ts.TypeReference;
}

function descriptorDiscriminator(
  descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'object' }>,
): ReadonlyMap<string, string | number | boolean> {
  const values = new Map<string, string | number | boolean>();
  for (const name of descriptor.required) {
    const property = descriptor.properties[name];
    if (property?.kind === 'literal') values.set(name, property.value);
  }
  return values;
}

function hasUniqueDiscriminator(
  alternatives: readonly Extract<ModelConversionDescriptor, { readonly kind: 'object' }>[],
): boolean {
  if (alternatives.length === 0) return false;
  const candidates = descriptorDiscriminator(alternatives[0]);
  for (const [property] of candidates) {
    const values: (string | number | boolean)[] = [];
    let valid = true;
    for (const alternative of alternatives) {
      const value = descriptorDiscriminator(alternative).get(property);
      if (value === undefined || values.includes(value)) {
        valid = false;
        break;
      }
      values.push(value);
    }
    if (valid) return true;
  }
  return false;
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
  const resolved = packageSpecifier(module, context.sourceFile.fileName);
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
  if (alternatives.some((item) =>
    item.kind === 'any'
      || item.kind === 'unknown'
      || item.kind === 'array'
      || item.kind === 'intersection'
  )) {
    throw diagnostic(
      context.sourceFile,
      context.declaration,
      '1030',
      `Generated model union in ${context.name} has an ambiguous object alternative. Use a primitive or a uniquely tagged object branch.`,
    );
  }
  const objects = alternatives.filter(
    (item): item is Extract<ModelConversionDescriptor, { readonly kind: 'object' }> => item.kind === 'object',
  );
  if (objects.length > 0 && !hasUniqueDiscriminator(objects)) {
    throw diagnostic(
      context.sourceFile,
      context.declaration,
      '1030',
      `Generated model union in ${context.name} has an ambiguous object alternative. Add a required literal discriminator.`,
    );
  }
}

function isErrorAny(type: ts.Type): boolean {
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
  return checker.getPropertiesOfType(type).some((property) => {
    const name = property.getName();
    return name.includes('validationTag')
      || name.includes('serdeTag')
      || name.includes('integerTag')
      || name.includes('minimumTag')
      || name.includes('maximumTag')
      || name.includes('exclusiveMinimumTag')
      || name.includes('exclusiveMaximumTag')
      || name.includes('multipleOfTag')
      || name.includes('minLengthTag')
      || name.includes('maxLengthTag')
      || name.includes('patternTag')
      || name.includes('formatTag')
      || name.includes('minItemsTag')
      || name.includes('maxItemsTag')
      || name.includes('uniqueItemsTag')
      || name.includes('minPropertiesTag')
      || name.includes('maxPropertiesTag')
      || name.includes('containsTag')
      || name.includes('minContainsTag')
      || name.includes('maxContainsTag')
      || name.includes('propertyNamesTag')
      || name.includes('patternPropertiesTag')
      || name.includes('additionalPropertiesTag')
      || name.includes('unevaluatedPropertiesTag')
      || name.includes('dependentRequiredTag')
      || name.includes('dependentSchemasTag')
      || name.includes('oneOfTag')
      || name.includes('notTag')
      || name.includes('ifThenElseTag');
  });
}

function stripPhantomIntersection(
  checker: ts.TypeChecker,
  type: ts.Type,
  metadata: TagMetadata,
): ts.Type {
  if (!metadata.validations.length && !metadata.serde && !metadata.constraints.length) return type;
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

function constraintFamily(kind: ModelConstraint['kind']): ConstraintFamily | undefined {
  switch (kind) {
    case 'integer':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'multipleOf':
      return 'number';
    case 'minLength':
    case 'maxLength':
    case 'pattern':
    case 'format':
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
    const family = constraintFamily(constraint.kind);
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

function additionalPropertiesFromTags(
  constraints: readonly ModelConstraint[],
): boolean | undefined {
  const additional = constraints.find((constraint) => constraint.kind === 'additionalProperties');
  if (!additional || additional.kind !== 'additionalProperties') return undefined;
  const schema = additional.schema;
  if (schema === false) return false;
  if (typeof schema === 'object' && schema !== null && 'kind' in schema) {
    const kind = (schema as { readonly kind: string }).kind;
    if (kind === 'never' || kind === 'undefined') return false;
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

export function descriptorBuilder(
  checker: ts.TypeChecker,
  specifications: readonly ModelSpecification[],
  manifestIndex: ManifestIndex,
  validationEnabled: boolean,
  allowAny = false,
  identityRoot?: string,
  compilerOptions?: ts.CompilerOptions,
  allowUnresolved = true,
  /** Name that references to a model and its derived projections use; the model's own name when omitted. */
  nameFor?: (specification: ModelSpecification) => string,
  /** Canonical model source files of the job, which have a generated companion; omitted when the analysis emits none. */
  modelSources?: ReadonlySet<string>,
  /** The models-job boundary, for the diagnostic of a field that nests a model this job does not own. */
  boundary?: ModelBoundary,
): {
  (type: ts.Type, context: TypeAnalysisContext, seen?: ReadonlySet<ts.Type>, node?: ts.TypeNode): ModelConversionDescriptor;
  readonly projections: ReadonlyMap<string, ModelConversionDescriptor>;
} {
  const projections = new Map<string, ModelConversionDescriptor>();
  const projectionCache = new Map<ts.Type, Map<string, string>>();
  // Where each projection name was first minted, for the clash diagnostic.
  const projectionSources = new Map<string, string>();
  const sourceLocation = (at: ts.Node): string => {
    const sourceFile = at.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile));
    return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
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
  const structuralModels = new Map<ts.Type, ModelSpecification | undefined>();
  const structuralModel = (type: ts.Type): ModelSpecification | undefined => {
    if (structuralModels.has(type)) return structuralModels.get(type);
    const match = uniqueStructuralModel(checker, type, specifications);
    structuralModels.set(type, match);
    return match;
  };

  const describe = (
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
      ...(modelSources ? { isModelSource: (filename: string) => modelSources.has(filename) } : {}),
      diagnostic: (tagNode: ts.Node, code: string, message: string) =>
        diagnostic(context.sourceFile, tagNode, code, message),
      describeSchema: (schemaType: ts.Type, schemaNode?: ts.TypeNode) =>
        describe(schemaType, { ...context, exact: false, schemaData: true }, seen, schemaNode, representation, undefined, undefined, nameHint),
    };
    // Analyze checker types even when a child has no corresponding AST node
    // (for example the Date branch of `Date | undefined`).
    const analysis = analyzeNode(tagContext, originalType, node);
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
      || metadata.date === true;
    const baseType = stripPhantomIntersection(
      checker,
      hasTagMetadata && analysis.baseNode
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

    // Validate the codec against the projected model type before handling
    // Date as a terminal descriptor.  A tagged Date still has a concrete
    // model-side type, so an incompatible serializer/deserializer must be
    // rejected rather than hidden by the Date shortcut below.
    if (metadata.serde && (type.flags & ts.TypeFlags.TypeParameter) === 0) {
      assertSerdeCompatibility(checker, metadata.serde, type, context);
    }

    // A custom serde can intersect Date with its phantom marker.  The
    // checker then no longer reports the original intersection as Date, but
    // the projected base type still is Date and must remain terminal.
    if (metadata.date || isDateType(checker, type)) {
      return withMetadata({ kind: 'date' } as unknown as ModelConversionDescriptor, {
        ...metadata,
        date: true,
      });
    }

    // A class instance or bigint has no JSON shape of its own; its TSerde codec is its only conversion.
    if (metadata.serde && isBigIntValueType(type)) {
      return withMetadata({ kind: 'class-value', typeName: 'bigint' } as ModelConversionDescriptor, metadata);
    }
    if (metadata.serde && isClassValueType(checker, type)) {
      return withMetadata({ kind: 'class-value', ...classValueReference(checker, type, context, node ?? context.declaration) } as ModelConversionDescriptor, metadata);
    }

    const provenance = fieldProvenance(checker, node ?? provenanceNode ?? analysis.baseNode, specifications);
    if (provenance.anonymous) {
      const alias = declaredModelAlias(provenance.anonymous);
      const foreign = alias ? foreignModelReason(alias, boundary) : undefined;
      if (foreign !== undefined) throw diagnostic(context.sourceFile, node ?? context.declaration, '1074', foreign);
      throw diagnostic(context.sourceFile, node ?? context.declaration, '1053', 'Nested IModel definitions need a named, exported declaration.');
    }
    const projection = provenance.projection || isPropertyMapping(type);
    if (projection) {
      for (const original of provenance.models) {
        const whole = analyzeNode({ ...tagContext, sourceFile: original.sourceFile }, original.fieldsType, original.fieldsNode).metadata;
        if (whole.serde || whole.validations.length || whole.constraints.length) {
          throw diagnostic(context.sourceFile, node ?? context.declaration, '1055', `Projection of ${original.aliasName} would discard whole-object constraints or serialization. Declare an explicit projected contract.`);
        }
      }
    }
    const candidates = provenance.models.filter(specification => checker.isTypeAssignableTo(type, specification.fieldsType)
      && checker.isTypeAssignableTo(specification.fieldsType, type));
    if (!projection && candidates.length > 1 && !type.isUnion()) {
      throw diagnostic(context.sourceFile, node ?? context.declaration, '1054', 'Model identity is ambiguous after type composition. Use an explicit named model reference.');
    }
    const isRoot = node === context.fieldsNode;
    const classMatch = isRoot || type.isUnion() || isPropertyMapping(type) || projection
      ? undefined
      : modelSpecificationForClass(checker, type, specifications, compilerOptions);
    const projectedStructural = (): ModelSpecification | undefined => {
      const structural = structuralModel(type);
      return structural && !provenance.models.includes(structural) ? structural : undefined;
    };
    const localModel = classMatch ?? (isRoot || type.isUnion() || isPropertyMapping(type) ? undefined
      : projection
        ? projectedStructural()
        : (candidates[0]
          ?? modelSpecificationForType(checker, type, specifications)
          ?? (provenance.models.length > 0 ? structuralModel(type) : undefined)));
    const generatedName = localModel ? modelNames.get(localModel.declaration) : undefined;
    if (generatedName) {
      return withMetadata({
        kind: 'reference',
        name: generatedName,
        ...(!localModel?.emitClass ? { projection: true as const } : {}),
        ...(classMatch ? { construct: true as const, ...(type.getSymbol()?.getName() ? { className: type.getSymbol()!.getName() } : {}) } : {}),
      }, metadata);
    }
    const externalModel = manifestIndex.externalModelForType(type);
    if (externalModel) return withMetadata({ kind: 'generated-model', id: externalModel.id }, metadata);
    if (type.flags & ts.TypeFlags.Any) {
      if (!allowUnresolved && isErrorAny(type)) throw diagnostic(context.sourceFile, node ?? context.declaration, '1058', 'A contract type could not be resolved. Fix its declaration or import before generating OpenAPI.');
      const effectiveAllowAny = context.allowAny ?? allowAny;
      if (!effectiveAllowAny && !isErrorAny(type)) {
        throw diagnostic(
          context.sourceFile,
          context.declaration,
          '1011',
          `Model ${context.name} contains any. Replace it with a concrete type or unknown, or allow it with `
            + `{ allowAny: true } as the model's second type argument (IModel<Fields, { allowAny: true }>) `
            + 'or allowAny: true in golem.yaml.',
        );
      }
      return withMetadata(isErrorAny(type) ? { kind: 'unknown' } : { kind: 'any' }, metadata);
    }
    if (type.flags & ts.TypeFlags.Unknown) return withMetadata({ kind: 'unknown' }, metadata);
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
    if (type.isUnion()) {
      const variantNaming = unionVariantNaming(checker, node, type.types, context.declaration);
      const variants = type.types.map((variant) => describe(variant, context, seen, undefined, representation, node ?? provenanceNode, childSubstitutions, `${nameHint}${variantNaming.get(variant)?.part ?? ''}`, variantNaming.get(variant)?.node));
      // Checker member order differs between TypeScript backends and runs; output must not.
      variants.sort((left, right) => compareText(canonicalDescriptorKey(left), canonicalDescriptorKey(right)));
      const descriptor: Extract<ModelConversionDescriptor, { readonly kind: 'union' }> = { kind: 'union', variants };
      rejectAmbiguousGeneratedModelUnion(descriptor, context);
      return withMetadata(descriptor, metadata);
    }
    const objectLikeIntersection = type.isIntersection()
      && type.types.length > 0
      && type.types.every((member) =>
        (member.flags & ts.TypeFlags.Object) !== 0
        && !checker.isArrayType(member)
        && !checker.isTupleType(member)
        && member.getCallSignatures().length === 0
        && member.getConstructSignatures().length === 0,
      );
    if (type.isIntersection() && !objectLikeIntersection) {
      return withMetadata({
        kind: 'intersection',
        variants: type.types.map((variant) => describe(variant, context, seen, undefined, representation, undefined, undefined, nameHint)),
      }, metadata);
    }
    if (checker.isTupleType(type)) {
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
        const descriptor = describe(item, context, seen, itemNode, representation, undefined, childSubstitutions, nameHint, tupleElementNode(nameNode, index));
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
          rest: { index: restIndex, item: describe(restType, context, seen, tupleElementNode(childNode, restIndex), representation, undefined, childSubstitutions, nameHint, tupleElementNode(nameNode, restIndex)) },
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
      const [item] = checker.getTypeArguments(type as ts.TypeReference);
      const arrayNode = childNode && ts.isTypeOperatorNode(childNode)
        && childNode.operator === ts.SyntaxKind.ReadonlyKeyword
        ? childNode.type
        : childNode;
      return withMetadata({
        kind: 'array',
        ...(isReadonlySequenceType(checker, type) ? { isReadonly: true as const } : {}),
        item: describe(item ?? checker.getAnyType(), context, seen, arrayNode && ts.isArrayTypeNode(arrayNode) ? arrayNode.elementType : typeArgumentNode(arrayNode, 0), representation, undefined, childSubstitutions, nameHint, arrayItemNameNode(nameNode)),
      }, metadata);
    }
    if ((type.flags & ts.TypeFlags.Object) || objectLikeIntersection) {
      let projectionName: string | undefined;
      if (projection && !isRoot) {
        const nameAt = node ?? nameNode;
        const candidate = `${safeNameHint(projectionBaseName(checker, nameAt, modelNameOf, nameHint), nameHint)}${policySuffix({
          exact: context.exact, allowAny: context.allowAny ?? allowAny, representation,
        })}`;
        if (!isProjectionName(candidate)) throw new Error(`Internal error: projection name "${candidate}" is not a plain identifier.`);
        const here = sourceLocation(nameAt ?? context.declaration);
        const modelLocation = modelLocations.get(candidate);
        if (modelLocation) {
          throw diagnostic(context.sourceFile, nameAt ?? context.declaration, '1059',
            `Projection name ${candidate} is used by a projection and a model: ${here} and ${modelLocation}. Declare a named type alias for the projection.`);
        }
        const policy = `${context.exact}:${context.allowAny ?? allowAny}:${representation}:${candidate}`;
        const cached = projectionCache.get(type) ?? new Map<string, string>();
        projectionName = cached.get(policy);
        if (projectionName) return { kind: 'reference', name: projectionName, projection: true };
        projectionName = candidate;
        cached.set(policy, projectionName);
        projectionCache.set(type, cached);
        if (!projectionSources.has(candidate)) projectionSources.set(candidate, here);
      }
      if (seen.has(type) && !projectionName) {
        throw diagnostic(context.sourceFile, node ?? context.declaration, '1056', 'Recursive anonymous object conversion needs a named model or projected type.');
      }
      const primitiveConstructor = primitiveConstructorDescriptor(type);
      if (primitiveConstructor) return withMetadata(primitiveConstructor, metadata);
      if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
        if (!validationEnabled) return withMetadata({ kind: 'unknown' }, metadata);
        throw diagnostic(context.sourceFile, context.declaration, '1004', `Callable or constructible types cannot be represented by ${context.name}.`);
      }
      const nextSeen = new Set(seen);
      nextSeen.add(type);
      // Keep discovered field names as data until the generation diagnostic
      // rejects unsupported Object.prototype collisions; a normal object
      // would invoke the legacy setter for an own `__proto__` key.
      const properties: Record<string, ModelConversionDescriptor> = Object.create(null);
      const required: string[] = [];
      for (const property of checker.getPropertiesOfType(type)) {
        const name = property.getName();
        const isMethod = (property.flags & ts.SymbolFlags.Method) !== 0
          || property.declarations?.some(declaration => ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) === true;
        if (!context.schemaData && !isMethod) assertSupportedModelFieldName(name);
        if (context.dto && isMethod) continue;
        const valueType = propertyType(checker, property, context.declaration);
        if (valueType.getCallSignatures().length > 0) {
          if (!validationEnabled) {
            properties[name] = { kind: 'unknown' };
            if ((property.flags & ts.SymbolFlags.Optional) === 0) required.push(name);
            continue;
          }
          throw diagnostic(
            context.sourceFile,
            property.valueDeclaration ?? context.declaration,
            '1004',
            `Field "${name}" is callable and cannot be represented by ${context.name}.`,
          );
        }
        const propertyNode = authoredPropertyTypeNode(childNode, name) ?? propertyTypeNode(checker, property);
        properties[name] = describe(
          valueType,
          context,
          nextSeen,
          propertyNode,
          representation,
          propertyNode
            ?? (isPropertyMapping(type) ? node ?? provenanceNode : undefined),
          childSubstitutions,
          `${projectionName ?? nameHint}${pascalIdentifier(name) ?? 'Field'}`,
        );
        if ((property.flags & ts.SymbolFlags.Optional) === 0) required.push(name);
      }
      const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
      const taggedAdditional = additionalPropertiesFromTags(metadata.constraints);
      const descriptor = withMetadata({
        kind: 'object',
        ...(projection ? { projection: true as const } : {}),
        ...(readonlyPropertyNames(checker, type).length ? { readonlyProperties: readonlyPropertyNames(checker, type) } : {}),
        properties,
        required,
        additionalProperties: indexType
          ? describe(indexType, context, nextSeen, indexValueNode(childNode), representation, undefined, childSubstitutions, `${projectionName ?? nameHint}Value`)
          : taggedAdditional !== undefined
            ? taggedAdditional
            : !context.exact,
      }, metadata);
      if (projectionName) {
        const existing = projections.get(projectionName);
        if (existing) {
          const lookup = (name: string): ModelConversionDescriptor | undefined => projections.get(name);
          if (projectionIdentity(lookup, projectionName, existing) !== projectionIdentity(lookup, projectionName, descriptor)) {
            const nameAt = node ?? nameNode ?? context.declaration;
            throw diagnostic(context.sourceFile, nameAt, '1059',
              `Projection name ${projectionName} is used by two different types: ${projectionSources.get(projectionName)} and ${sourceLocation(nameAt)}. Declare a named type alias for one of them.`);
          }
          return { kind: 'reference', name: projectionName, projection: true };
        }
        projections.set(projectionName, descriptor);
        return { kind: 'reference', name: projectionName, projection: true };
      }
      return descriptor;
    }
    if (!validationEnabled) return withMetadata({ kind: 'unknown' }, metadata);
    throw diagnostic(
      context.sourceFile,
      context.declaration,
      '1003',
      `Unsupported TypeScript type in ${context.name}: ${checker.typeToString(type)}`,
    );
  };
  return Object.assign(describe, { projections });
}

export function mergeDescriptorMetadata(
  descriptor: ModelConversionDescriptor,
  ...metadata: readonly TagMetadata[]
): ModelConversionDescriptor {
  return withMetadata(descriptor, mergeTagMetadata(...metadata));
}
