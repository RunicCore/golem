import path from 'node:path';
import { displayPath } from '../generator-api.js';
import * as ts from '../typescript-ns.js';
import { canonicalFilename, portableRelativeFilename } from './project.js';
import { packageSpecifier } from './package-specifier.js';
import { canonicalConstraintKey } from '../schema.js';
import type { ConstraintSchemaValue, ModelConstraint } from '../schema.js';
export type { ConstraintSchemaValue, ModelConstraint } from '../schema.js';

export interface ValueBinding {
  readonly id: string;
  readonly module: string;
  readonly exportName: string;
  readonly declaration: ts.Declaration;
  /** Package import specifier, set only when the function lives in another package. */
  readonly specifier?: string;
}

export interface ValidationBinding extends ValueBinding {
  readonly kind: 'validation';
  readonly parameterType: ts.Type;
}

export interface SerdeBinding {
  readonly kind: 'serde';
  readonly id: string;
  readonly serialize: ValueBinding;
  readonly deserialize: ValueBinding;
  /** The model parameter accepted by serialize. */
  readonly modelType: ts.Type;
  /** Inferred wire type used for the JSON projection. */
  readonly wireType: ts.Type;
  /** The output types used to verify the pair at the model boundary. */
  readonly serializeType: ts.Type;
  readonly deserializeType: ts.Type;
}

export interface TagMetadata {
  readonly validations: readonly ValidationBinding[];
  readonly serde?: SerdeBinding;
  readonly constraints: readonly ModelConstraint[];
  readonly date?: true;
  /** The property a `Discriminator<Key>` tag names as the tag of a model object union. */
  readonly discriminator?: string;
  /** The `Default` type argument of that tag, when it names a variant. */
  readonly discriminatorDefault?: ts.Type;
}

export interface TagReadResult {
  readonly baseNode?: ts.TypeNode;
  readonly metadata: TagMetadata;
}

export interface TagAnalysisContext {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  /** Absolute project root used to keep emitted binding IDs relocatable. */
  readonly identityRoot: string;
  /** The generated file that imports what the tags name: the companion of the model's file. Defaults to the model's file. */
  readonly importer?: string;
  /** Whether a file is a model source of the job, so it has a generated companion. */
  readonly isModelSource?: (filename: string) => boolean;
  readonly diagnostic: (node: ts.Node, code: string, message: string) => Error;
  /** Resolve a tag's schema type without executing application code. */
  readonly describeSchema?: (type: ts.Type, node?: ts.TypeNode) => ConstraintSchemaValue;
  readonly aliasUseSite?: AliasUseSite;
  /**
   * The functions that the source read of one node wrote after `typeof`, by their type. The checker read of the same node
   * names a function from its type; a const with a function type annotation has no declaration to name it by. Consts that
   * share one type alias share one type: within one role, a type written with two different symbols maps to null and names no function.
   */
  readonly writtenFunctions?: WrittenFunctions;
}

type FunctionRole = 'validation' | 'serialize' | 'deserialize';
type WrittenFunctions = Readonly<Record<FunctionRole, Map<ts.Type, ts.Symbol | null>>>;

/** Generated validators compile JSON Schema patterns with the Unicode flag; analysis parses each pattern the same way, so a malformed one fails before any output is written. */
function isUnicodePattern(pattern: string): boolean {
  try {
    void new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

function newWrittenFunctions(): WrittenFunctions {
  return { validation: new Map(), serialize: new Map(), deserialize: new Map() };
}

/** The concrete alias reference a generic tag alias is being read for. */
interface AliasUseSite {
  /** The use-site reference node in the model file; diagnostics point here. */
  readonly node: ts.TypeReferenceNode;
  /** The checker's instantiated type of `node`: its tag members carry substituted arguments. */
  readonly type: ts.Type;
  /** Type parameters of every alias entered below `node`. */
  readonly parameters: ReadonlySet<ts.Symbol>;
}

const EMPTY: TagMetadata = Object.freeze({
  validations: [],
  constraints: [],
});

/** Merges the tags of two parts; two different Discriminator keys are a RUNM1051 at `at`. */
function mergeMetadata(context: TagAnalysisContext, at: ts.Node, first: TagMetadata, second: TagMetadata): TagMetadata {
  const validations = new Map<string, ValidationBinding>();
  for (const binding of [...first.validations, ...second.validations]) validations.set(binding.id, binding);
  const constraints = new Map<string, ModelConstraint>();
  for (const constraint of [...first.constraints, ...second.constraints]) {
    constraints.set(`${constraint.kind}\0${canonicalConstraintKey(constraint)}`, constraint);
  }
  if (first.serde && second.serde) {
    if (first.serde.id !== second.serde.id) {
      throw new Error(
        `Conflicting serde tags: ${first.serde.id} and ${second.serde.id}. `
        + 'A model value can have only one serialize/deserialize pair.',
      );
    }
  }
  if (first.discriminator !== undefined && second.discriminator !== undefined && first.discriminator !== second.discriminator) {
    throw context.diagnostic(at, '1051', `Conflicting Discriminator tags: '${first.discriminator}' and '${second.discriminator}'. A union has one tag key.`);
  }
  const discriminator = first.discriminator ?? second.discriminator;
  const discriminatorDefault = first.discriminatorDefault ?? second.discriminatorDefault;
  return {
    validations: [...validations.values()],
    constraints: [...constraints.values()],
    ...(first.serde ?? second.serde ? { serde: first.serde ?? second.serde } : {}),
    ...(first.date || second.date ? { date: true } : {}),
    ...(discriminator === undefined ? {} : { discriminator }),
    ...(discriminatorDefault === undefined ? {} : { discriminatorDefault }),
  };
}

/** A tag argument: the type node it was written as (the source path) or the checker's type for it (the instantiated path). */
interface TagArgument {
  readonly node?: ts.TypeNode;
  readonly type?: ts.Type;
}

function argumentType(checker: ts.TypeChecker, argument: TagArgument | undefined): ts.Type | undefined {
  return argument?.type ?? (argument?.node ? checker.getTypeFromTypeNode(argument.node) : undefined);
}

function literalValue(
  checker: ts.TypeChecker,
  argument: TagArgument | undefined,
  expected: 'number' | 'string',
): number | string | undefined {
  if (!argument) return undefined;
  const node = argument.node;
  if (node && expected === 'string') {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal.text;
    if (ts.isTemplateLiteralTypeNode(node) && node.templateSpans.length === 0) return node.head.text;
  }
  if (node && expected === 'number') {
    if (ts.isLiteralTypeNode(node) && ts.isNumericLiteral(node.literal)) return Number(node.literal.text);
    if (
      ts.isLiteralTypeNode(node)
      && ts.isPrefixUnaryExpression(node.literal)
      && node.literal.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(node.literal.operand)
    ) return -Number(node.literal.operand.text);
  }
  const type = argumentType(checker, argument);
  if (!type) return undefined;
  if (expected === 'number' && (type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    return (type as ts.NumberLiteralType).value;
  }
  if (expected === 'string' && (type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return (type as ts.StringLiteralType).value;
  }
  if (expected === 'number') {
    const text = checker.typeToString(type);
    const value = Number(text);
    return Number.isFinite(value) && text.trim() !== '' ? value : undefined;
  }
  return undefined;
}

function targetSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function declarationOf(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
  const declarations = symbol?.declarations ?? [];
  return declarations.find((declaration) =>
    ts.isVariableDeclaration(declaration)
    || ts.isFunctionDeclaration(declaration)
    || ts.isMethodDeclaration(declaration)
    || ts.isPropertyDeclaration(declaration)
    || ts.isPropertySignature(declaration),
  ) ?? declarations[0];
}

function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list)
    && (list.flags & ts.NodeFlags.Const) !== 0;
}

function symbolAtExpression(
  checker: ts.TypeChecker,
  expression: ts.EntityName | ts.Expression,
): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(expression);
}

function canonicalValue(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  seen = new Set<ts.Symbol>(),
): { readonly symbol: ts.Symbol; readonly declaration: ts.Declaration } | undefined {
  const resolved = targetSymbol(checker, symbol);
  if (!resolved || seen.has(resolved)) return undefined;
  seen.add(resolved);
  const declaration = declarationOf(resolved);
  if (
    declaration
    && ts.isVariableDeclaration(declaration)
    && isConstDeclaration(declaration)
    && declaration.initializer
    && (ts.isIdentifier(declaration.initializer) || ts.isPropertyAccessExpression(declaration.initializer))
  ) {
    const alias = canonicalValue(checker, symbolAtExpression(checker, declaration.initializer), seen);
    if (alias) return alias;
  }
  return declaration ? { symbol: resolved, declaration } : undefined;
}

/** A project function is identified by its file and export name, like a packaged one, so reformatting the file keeps the id. */
function canonicalIdentity(declaration: ts.Declaration, exportName: string, identityRoot: string): string {
  // A function outside the project is named by its path from the identity root, which may start with `..`.
  return `${portableRelativeFilename(declaration.getSourceFile().fileName, identityRoot)}#${exportName}`;
}

/** Whether `filename` is the golem source or declaration file named `stem` (`tags`, `model`), in a package install or in this workspace. */
export function isGolemSourceFile(filename: string, stem: 'tags' | 'model'): boolean {
  const normalized = filename.replace(/\\/g, '/');
  return new RegExp(`(?:^|/)(?:node_modules/@exprtlabs/golem|packages/golem)/(?:src|dist)/${stem}(?:\\.d)?\\.(?:c|m)?ts$`).test(normalized);
}

function isGolemTagSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean {
  const target = targetSymbol(checker, symbol);
  return Boolean(target?.declarations?.some((declaration) => isGolemSourceFile(declaration.getSourceFile().fileName, 'tags')));
}

/** Whether `property` is the key of a golem tag: a property named by one of the unique symbols that tags.ts declares. */
export function isGolemTagKey(checker: ts.TypeChecker, property: ts.Symbol): boolean {
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  const key = declaration && (declaration as ts.NamedDeclaration).name;
  return key !== undefined && ts.isComputedPropertyName(key) && isGolemTagSymbol(checker, checker.getSymbolAtLocation(key.expression));
}

/**
 * The name `declaration`'s module exports `symbol` under. A function must be exported by name; a class can also be
 * the default export (`allowDefault`), which generated code imports as `default`.
 */
export function publicExportName(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  symbol: ts.Symbol,
  allowDefault = false,
): string | undefined {
  const sourceFile = declaration.getSourceFile();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol) {
    const candidates = checker.getExportsOfModule(moduleSymbol)
      .filter((candidate) => {
        const resolved = targetSymbol(checker, candidate);
        return resolved === symbol || (resolved && resolved.declarations?.some((item) => item === declaration));
      })
      .map((candidate) => candidate.getName())
      .sort();
    return candidates.find((name) => name !== 'default') ?? (allowDefault ? candidates[0] : undefined);
  }
  return undefined;
}

function valueBindingForSymbol(
  context: TagAnalysisContext,
  symbol: ts.Symbol | undefined,
  kind: 'validation' | 'serialize' | 'deserialize',
  node: ts.Node,
): ValueBinding {
  const canonical = canonicalValue(context.checker, symbol);
  if (!canonical) {
    throw context.diagnostic(
      node,
      '1040',
      `Could not resolve ${kind} function declaration.`,
    );
  }
  const { declaration } = canonical;
  const sourceFile = declaration.getSourceFile();
  const exportName = publicExportName(context.checker, declaration, canonical.symbol);
  if (!exportName || exportName === 'unknown') {
    throw context.diagnostic(
      node,
      '1040',
      `${kind} function must be exported so generated code can call it.`,
    );
  }
  const resolved = packageSpecifier(canonicalFilename(sourceFile.fileName), context.importer ?? context.sourceFile.fileName, context.identityRoot);
  if (resolved.kind !== 'package' && context.isModelSource?.(canonicalFilename(sourceFile.fileName))) {
    // The shared generated module imports this function; from a model file that would close a cycle with the
    // file's generated companion, which breaks start-up whenever the companion loads first.
    throw context.diagnostic(
      node,
      '1065',
      `${kind} function ${exportName} is declared in the model file ${path.basename(sourceFile.fileName)}. Move it to its own module and import it from there.`,
    );
  }
  if (resolved.kind === 'unexported') {
    throw context.diagnostic(
      node,
      '1060',
      `${kind} function ${exportName} is in package ${resolved.packageName}, but no "exports" entry in ${displayPath(path.join(resolved.packageRoot, 'package.json'))} reaches ${path.relative(resolved.packageRoot, sourceFile.fileName)}. Export that file from the package.`,
    );
  }
  if (resolved.kind === 'package') {
    // A packaged function is identified by its public import, not its file offsets: the identity then survives
    // package upgrades and relocation, and a package reached through two paths collapses to one binding.
    return { id: `${resolved.specifier}#${exportName}`, module: canonicalFilename(sourceFile.fileName), exportName, declaration, specifier: resolved.specifier };
  }
  return {
    id: canonicalIdentity(declaration, exportName, context.identityRoot),
    module: canonicalFilename(sourceFile.fileName),
    exportName,
    declaration,
  };
}

/** A function that a TValidation or TSerde tag names: the `typeof` query that wrote it, when the tag was read from source. */
interface TagFunction {
  readonly query?: ts.TypeQueryNode;
  readonly type: ts.Type;
  /** Where its diagnostics point. */
  readonly owner: ts.Node;
}

/** The function `argument` names. A tag read from source must write `typeof name`; `code` and `message` refuse anything else, and a missing argument. */
function functionArgument(
  context: TagAnalysisContext,
  argument: TagArgument | undefined,
  at: ts.Node,
  code: string,
  message: string,
): TagFunction {
  if (argument?.node && ts.isTypeQueryNode(argument.node)) {
    return { query: argument.node, type: context.checker.getTypeAtLocation(argument.node.exprName), owner: argument.node };
  }
  if (argument?.type && !argument.node) return { type: argument.type, owner: at };
  throw context.diagnostic(at, code, message);
}

function functionBinding(
  context: TagAnalysisContext,
  fn: TagFunction,
  kind: 'validation' | 'serialize' | 'deserialize',
): ValueBinding {
  if (fn.query) {
    const written = symbolAtExpression(context.checker, fn.query.exprName);
    const known = context.writtenFunctions?.[kind].get(fn.type);
    if (written && known !== null) context.writtenFunctions?.[kind].set(fn.type, known === undefined || known === written ? written : null);
    return valueBindingForSymbol(context, written, kind, fn.owner);
  }
  const declaration = fn.type.getCallSignatures()[0]?.declaration;
  const variable = declaration && ts.isFunctionLike(declaration)
    && (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))
    && ts.isVariableDeclaration(declaration.parent)
    ? declaration.parent
    : undefined;
  const named = variable?.name
    ?? (declaration && (declaration as ts.NamedDeclaration).name);
  const written = context.writtenFunctions?.[kind].get(fn.type);
  if (written === null && !named) {
    throw context.diagnostic(fn.owner, '1040', `${kind} function shares its type with another function in this field, so golem cannot tell which one the tag names. Declare it with \`function\` or give it its own type.`);
  }
  const symbol = (named ? context.checker.getSymbolAtLocation(named) : undefined) ?? written ?? undefined;
  return valueBindingForSymbol(context, symbol, kind, fn.owner);
}

function validateSynchronousSignature(
  context: TagAnalysisContext,
  type: ts.Type,
  node: ts.Node,
  kind: 'validation' | 'serialize' | 'deserialize',
): ts.Signature {
  const signatures = type.getCallSignatures();
  const signature = signatures[0];
  if (!signature || signatures.length !== 1) {
    throw context.diagnostic(node, '1046', `${kind} must be a single callable function.`);
  }
  const required = signature.parameters.filter((parameter) => {
    const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
    return !declaration || !ts.isParameter(declaration) || declaration.dotDotDotToken === undefined && declaration.questionToken === undefined;
  });
  if (signature.parameters.length !== 1 || required.length !== 1) {
    throw context.diagnostic(node, '1046', `${kind} must accept exactly one required parameter.`);
  }
  const returnType = context.checker.getReturnTypeOfSignature(signature);
  const isThenable = (candidate: ts.Type): boolean => {
    if (candidate.isUnion() || candidate.isIntersection()) return candidate.types.some(isThenable);
    return candidate.getProperty('then') !== undefined;
  };
  if (isThenable(returnType)) {
    throw context.diagnostic(node, '1047', `${kind} must be synchronous.`);
  }
  return signature;
}

function parameterType(
  checker: ts.TypeChecker,
  signature: ts.Signature,
  location: ts.Node,
): ts.Type {
  const parameter = signature.parameters[0];
  const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
  return parameter
    ? checker.getTypeOfSymbolAtLocation(parameter, declaration ?? location)
    : checker.getUnknownType();
}

function validationSignature(
  context: TagAnalysisContext,
  fn: TagFunction,
): ts.Signature {
  const signature = validateSynchronousSignature(context, fn.type, fn.owner, 'validation');
  const returnType = context.checker.getReturnTypeOfSignature(signature);
  const allowed = (candidate: ts.Type): boolean => {
    if ((candidate.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike)) !== 0) return true;
    if (candidate.isUnion()) return candidate.types.every(allowed);
    return false;
  };
  if (!allowed(returnType)) {
    throw context.diagnostic(fn.owner, '1048', 'validation must return boolean or string synchronously.');
  }
  return signature;
}

function schemaArgument(
  context: TagAnalysisContext,
  argument: TagArgument | undefined,
  owner: ts.Node,
  label: string,
): ConstraintSchemaValue {
  return schemaTypeArgument(context, argumentType(context.checker, argument), owner, label, argument?.node);
}

function schemaTypeArgument(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  owner: ts.Node,
  label: string,
  node?: ts.TypeNode,
): ConstraintSchemaValue {
  if (!type || !context.describeSchema) {
    throw context.diagnostic(owner, '1043', `${label} requires a representable schema type argument.`);
  }
  return context.describeSchema(type, node);
}

function propertyTypeNode(
  property: ts.Symbol,
): ts.TypeNode | undefined {
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  return declaration && (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration))
    ? declaration.type
    : undefined;
}

function literalString(
  context: TagAnalysisContext,
  type: ts.Type,
  node: ts.TypeNode | undefined,
  owner: ts.Node,
  label: string,
): string {
  const value = literalValue(context.checker, { node }, 'string');
  if (typeof value === 'string') return value;
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) return (type as ts.StringLiteralType).value;
  throw context.diagnostic(owner, '1044', `${label} requires a string literal argument.`);
}

function schemaList(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  node: ts.TypeNode | undefined,
  owner: ts.Node,
  label: string,
): readonly ConstraintSchemaValue[] {
  if (!type) throw context.diagnostic(owner, '1043', `${label} requires at least one schema type.`);
  const values = type.isUnion()
    ? type.types
    : context.checker.isTupleType(type)
      ? context.checker.getTypeArguments(type as ts.TypeReference)
      : (() => {
        const argument = context.checker.isArrayType(type)
          ? context.checker.getTypeArguments(type as ts.TypeReference)[0]
          : undefined;
        return argument?.isUnion() ? argument.types : argument ? [argument] : [type];
      })();
  if (values.length === 0) throw context.diagnostic(owner, '1043', `${label} requires at least one schema type.`);
  const nodes = node && ts.isTupleTypeNode(node) ? node.elements : [];
  return values.map((value, index) => schemaTypeArgument(context, value, owner, label, nodes[index]));
}

function stringList(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  node: ts.TypeNode | undefined,
  owner: ts.Node,
  label: string,
): readonly string[] {
  if (!type) throw context.diagnostic(owner, '1043', `${label} requires a string tuple or string-literal union.`);
  const values = context.checker.isTupleType(type)
    ? context.checker.getTypeArguments(type as ts.TypeReference)
    : type.isUnion()
      ? type.types
      : context.checker.isArrayType(type)
        ? [context.checker.getTypeArguments(type as ts.TypeReference)[0]]
        : [];
  const nodes = node && ts.isTupleTypeNode(node) ? node.elements : [];
  if (values.length === 0) throw context.diagnostic(owner, '1043', `${label} requires a string tuple or string-literal union.`);
  return values.map((value, index) => literalString(context, value, nodes[index], owner, label));
}

function schemaMap(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  node: ts.TypeNode | undefined,
  owner: ts.Node,
  label: string,
): Readonly<Record<string, ConstraintSchemaValue>> {
  if (!type || (type.flags & ts.TypeFlags.Object) === 0) {
    throw context.diagnostic(owner, '1043', `${label} requires an object mapping.`);
  }
  const result: Record<string, ConstraintSchemaValue> = Object.create(null);
  for (const property of context.checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? owner;
    const valueType = context.checker.getTypeOfSymbolAtLocation(property, declaration);
    result[property.getName()] = schemaTypeArgument(context, valueType, owner, label, propertyTypeNode(property));
  }
  if (Object.keys(result).length === 0) {
    throw context.diagnostic(owner, '1043', `${label} requires an object mapping with at least one property.`);
  }
  void node;
  return result;
}

function patternSchemaMap(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  node: ts.TypeNode | undefined,
  owner: ts.Node,
  label: string,
): Readonly<Record<string, ConstraintSchemaValue>> {
  const result = schemaMap(context, type, node, owner, label);
  for (const pattern of Object.keys(result)) {
    if (!isUnicodePattern(pattern)) throw context.diagnostic(owner, '1044', `${label} requires valid Unicode regular expression keys.`);
  }
  return result;
}

function dependentRequiredMap(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  node: ts.TypeNode | undefined,
  owner: ts.Node,
): Readonly<Record<string, readonly string[]>> {
  if (!type || (type.flags & ts.TypeFlags.Object) === 0) {
    throw context.diagnostic(owner, '1043', 'DependentRequired requires an object mapping.');
  }
  const result: Record<string, readonly string[]> = Object.create(null);
  for (const property of context.checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? owner;
    const valueType = context.checker.getTypeOfSymbolAtLocation(property, declaration);
    result[property.getName()] = stringList(context, valueType, propertyTypeNode(property), owner, 'DependentRequired values');
  }
  if (Object.keys(result).length === 0) {
    throw context.diagnostic(owner, '1043', 'DependentRequired requires an object mapping with at least one property.');
  }
  void node;
  return result;
}

/** Reads one tag from its name and arguments; `at` is where its diagnostics point. */
type TagReader = (context: TagAnalysisContext, name: string, args: readonly TagArgument[], at: ts.Node) => TagMetadata;

function constraintOnly(constraint: ModelConstraint): TagMetadata {
  return { validations: [], constraints: [constraint] };
}

function readValidation(context: TagAnalysisContext, _name: string, args: readonly TagArgument[], at: ts.Node): TagMetadata {
  const predicate = functionArgument(context, args[0], at, '1041', 'TValidation requires typeof an exported synchronous predicate.');
  const signature = validationSignature(context, predicate);
  return {
    validations: [{
      kind: 'validation',
      ...functionBinding(context, predicate, 'validation'),
      parameterType: parameterType(context.checker, signature, at),
    }],
    constraints: [],
  };
}

function readSerde(context: TagAnalysisContext, _name: string, args: readonly TagArgument[], at: ts.Node): TagMetadata {
  const message = 'TSerde requires typeof serialize and typeof deserialize functions.';
  const serializeFunction = functionArgument(context, args[0], at, '1042', message);
  const deserializeFunction = functionArgument(context, args[1], at, '1042', message);
  const serializeSignature = validateSynchronousSignature(context, serializeFunction.type, serializeFunction.owner, 'serialize');
  const deserializeSignature = validateSynchronousSignature(context, deserializeFunction.type, deserializeFunction.owner, 'deserialize');
  const serialize = functionBinding(context, serializeFunction, 'serialize');
  const deserialize = functionBinding(context, deserializeFunction, 'deserialize');
  return {
    validations: [],
    serde: {
      kind: 'serde',
      id: `${serialize.id}\0${deserialize.id}`,
      serialize,
      deserialize,
      modelType: parameterType(context.checker, serializeSignature, at),
      wireType: parameterType(context.checker, deserializeSignature, at),
      serializeType: context.checker.getReturnTypeOfSignature(serializeSignature),
      deserializeType: context.checker.getReturnTypeOfSignature(deserializeSignature),
    },
    constraints: [],
  };
}

function numberTag(kind: ModelConstraint['kind']): TagReader {
  return (context, name, args, at) => {
    const value = literalValue(context.checker, args[0], 'number');
    if (value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
      throw context.diagnostic(at, '1043', `${name} requires a finite numeric literal argument.`);
    }
    if (
      (kind === 'minLength' || kind === 'maxLength' || kind === 'minItems' || kind === 'maxItems'
        || kind === 'minProperties' || kind === 'maxProperties' || kind === 'minContains' || kind === 'maxContains')
      && (!Number.isInteger(value) || value < 0)
    ) {
      throw context.diagnostic(at, '1043', `${name} requires a non-negative integer literal argument.`);
    }
    if (kind === 'multipleOf' && value <= 0) {
      throw context.diagnostic(at, '1043', `${name} requires a positive numeric literal argument.`);
    }
    return constraintOnly({ kind, value } as ModelConstraint);
  };
}

function stringTag(kind: 'pattern' | 'format'): TagReader {
  return (context, name, args, at) => {
    const value = literalValue(context.checker, args[0], 'string');
    if (typeof value !== 'string') throw context.diagnostic(at, '1044', `${name} requires a string literal argument.`);
    if (kind === 'pattern') {
      if (!isUnicodePattern(value)) throw context.diagnostic(at, '1044', `${name} requires a valid Unicode regular expression.`);
    }
    return constraintOnly({ kind, value });
  };
}

function schemaTag(kind: 'contains' | 'propertyNames' | 'additionalProperties' | 'unevaluatedProperties' | 'not'): TagReader {
  return (context, name, args, at) => constraintOnly({ kind, schema: schemaArgument(context, args[0], at, name) });
}

function readPatternProperties(context: TagAnalysisContext, name: string, args: readonly TagArgument[], at: ts.Node): TagMetadata {
  const patterns = patternSchemaMap(context, argumentType(context.checker, args[0]), args[0]?.node, at, name);
  return {
    validations: [],
    constraints: Object.entries(patterns).map(([pattern, schema]) => ({ kind: 'patternProperties', pattern, schema })),
  };
}

function readIfThenElse(context: TagAnalysisContext, name: string, args: readonly TagArgument[], at: ts.Node): TagMetadata {
  const condition = schemaArgument(context, args[0], at, name);
  const thenSchema = schemaArgument(context, args[1], at, name);
  const elseSchema = args[2] ? schemaArgument(context, args[2], at, name) : undefined;
  return constraintOnly({ kind: 'ifThenElse', if: condition, then: thenSchema, ...(elseSchema === undefined ? {} : { else: elseSchema }) });
}

function readDiscriminator(context: TagAnalysisContext, name: string, args: readonly TagArgument[], at: ts.Node): TagMetadata {
  const key = literalValue(context.checker, args[0], 'string');
  if (typeof key !== 'string') throw context.diagnostic(at, '1044', `${name} requires a string literal argument.`);
  const declared = argumentType(context.checker, args[1]);
  const discriminatorDefault = declared && (declared.flags & ts.TypeFlags.Never) === 0 ? declared : undefined;
  return { validations: [], constraints: [], discriminator: key, ...(discriminatorDefault ? { discriminatorDefault } : {}) };
}

/** Every tag golem reads, by the name its declaration in tags.ts carries. One reader serves a tag written in source and a tag the checker instantiated. */
const TAG_READERS: ReadonlyMap<string, TagReader> = new Map<string, TagReader>([
  ['TValidation', readValidation],
  ['TSerde', readSerde],
  ['Integer', () => constraintOnly({ kind: 'integer' })],
  ['Minimum', numberTag('minimum')],
  ['Min', numberTag('minimum')],
  ['Maximum', numberTag('maximum')],
  ['Max', numberTag('maximum')],
  ['ExclusiveMinimum', numberTag('exclusiveMinimum')],
  ['ExclusiveMin', numberTag('exclusiveMinimum')],
  ['ExclusiveMaximum', numberTag('exclusiveMaximum')],
  ['ExclusiveMax', numberTag('exclusiveMaximum')],
  ['MultipleOf', numberTag('multipleOf')],
  ['MinLength', numberTag('minLength')],
  ['MaxLength', numberTag('maxLength')],
  ['MinItems', numberTag('minItems')],
  ['MaxItems', numberTag('maxItems')],
  ['MinProperties', numberTag('minProperties')],
  ['MinProps', numberTag('minProperties')],
  ['MaxProperties', numberTag('maxProperties')],
  ['MaxProps', numberTag('maxProperties')],
  ['MinContains', numberTag('minContains')],
  ['MaxContains', numberTag('maxContains')],
  ['Pattern', stringTag('pattern')],
  ['Format', stringTag('format')],
  ['UniqueItems', () => constraintOnly({ kind: 'uniqueItems' })],
  ['Contains', schemaTag('contains')],
  ['PropertyNames', schemaTag('propertyNames')],
  ['AdditionalProperties', schemaTag('additionalProperties')],
  ['UnevaluatedProperties', schemaTag('unevaluatedProperties')],
  ['Not', schemaTag('not')],
  ['PatternProperties', readPatternProperties],
  ['DependentRequired', (context, name, args, at) => constraintOnly({
    kind: 'dependentRequired',
    value: dependentRequiredMap(context, argumentType(context.checker, args[0]), args[0]?.node, at),
  })],
  ['DependentSchemas', (context, name, args, at) => constraintOnly({
    kind: 'dependentSchemas',
    value: schemaMap(context, argumentType(context.checker, args[0]), args[0]?.node, at, name),
  })],
  ['OneOf', (context, name, args, at) => constraintOnly({
    kind: 'oneOf',
    schemas: schemaList(context, argumentType(context.checker, args[0]), args[0]?.node, at, name),
  })],
  ['IfThenElse', readIfThenElse],
  ['Discriminator', readDiscriminator],
]);

/**
 * The tag a symbol names, or undefined when it is no golem tag. The meaning comes from the tag the symbol resolves to; the name
 * written at a use site is the importer's choice.
 */
function golemTagName(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): string | undefined {
  if (!isGolemTagSymbol(checker, symbol)) return undefined;
  const name = targetSymbol(checker, symbol)?.getName();
  return name !== undefined && TAG_READERS.has(name) ? name : undefined;
}

function dependsOnAliasParameter(context: TagAnalysisContext, node: ts.Node): boolean {
  const parameters = context.aliasUseSite?.parameters;
  if (!parameters?.size) return false;
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName)) {
      const symbol = context.checker.getSymbolAtLocation(child.typeName);
      if (symbol && parameters.has(symbol)) { found = true; return; }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function instantiatedTag(context: TagAnalysisContext, name: string): TagMetadata {
  const useSite = context.aliasUseSite!;
  const atUseSite: TagAnalysisContext = { ...context, diagnostic: (_node, code, message) => context.diagnostic(useSite.node, code, message) };
  const members = (useSite.type.isIntersection() ? useSite.type.types : [useSite.type])
    .filter((member) => member.aliasSymbol?.getName() === name && isGolemTagSymbol(context.checker, member.aliasSymbol));
  if (members.length === 0) {
    // The checker names an instantiated tag by the alias that wrote it last, so a tag behind `type Inner<N> = MaxLength<N>` is not found as `MaxLength`.
    throw atUseSite.diagnostic(useSite.node, '1064', `${useSite.node.getText()} has a ${name} tag that depends on a type parameter, but the type shows no ${name} tag because another type alias wraps it. Write ${name} directly in the alias that declares the type parameter.`);
  }
  if (members.length > 1) {
    throw atUseSite.diagnostic(useSite.node, '1062', `${useSite.node.getText()} holds more than one ${name} tag, and one depends on a type parameter. Keep one ${name} per alias.`);
  }
  return parseCheckerTag(atUseSite, members[0]!)!;
}

function parseTag(
  context: TagAnalysisContext,
  node: ts.TypeReferenceNode,
): TagMetadata | undefined {
  const name = golemTagName(context.checker, context.checker.getSymbolAtLocation(node.typeName));
  if (!name) return undefined;
  const arguments_ = node.typeArguments ?? [];
  if (arguments_.some((argument) => dependsOnAliasParameter(context, argument))) {
    if (name === 'TValidation' || name === 'TSerde') {
      const useSite = context.aliasUseSite!;
      throw context.diagnostic(useSite.node, '1061', `${name} in ${useSite.node.getText()} must name exported functions with typeof, not a type parameter.`);
    }
    return instantiatedTag(context, name);
  }
  return TAG_READERS.get(name)!(context, name, arguments_.map((argument) => ({ node: argument })), node);
}

function parseCheckerTag(
  context: TagAnalysisContext,
  type: ts.Type,
): TagMetadata | undefined {
  const name = golemTagName(context.checker, type.aliasSymbol);
  if (!name) return undefined;
  return TAG_READERS.get(name)!(context, name, (type.aliasTypeArguments ?? []).map((argument) => ({ type: argument })), context.sourceFile);
}

function metadataFromType(
  context: TagAnalysisContext,
  type: ts.Type,
  seen = new Set<ts.Type>(),
): TagMetadata {
  if (seen.has(type)) return EMPTY;
  seen.add(type);
  const direct = parseCheckerTag(context, type);
  if (direct) return direct;
  if (type.isIntersection()) {
    return type.types.reduce(
      (metadata, member) => mergeMetadata(context, context.sourceFile, metadata, metadataFromType(context, member, seen)),
      EMPTY,
    );
  }
  return EMPTY;
}

/** Whether a type node is a reference to the `Discriminator` tag, by the tag the symbol resolves to (the importer's name for it does not matter). */
export function isDiscriminatorTag(checker: ts.TypeChecker, node: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(node) && golemTagName(checker, checker.getSymbolAtLocation(node.typeName)) === 'Discriminator';
}

/** The type without its `Discriminator` tag members: `A & Discriminator<'k'>` is `A`. A type with no such member is returned as it is. */
export function withoutDiscriminator(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  if (!type.isIntersection()) return type;
  const rest = type.types.filter((member) => golemTagName(checker, member.aliasSymbol) !== 'Discriminator');
  return rest.length === 1 && rest.length < type.types.length ? rest[0] : type;
}

/**
 * The constituents of a type without its `Discriminator` tag members. The checker distributes `(A | B) & Discriminator<'k'>` over the union,
 * so a variant is `A & Discriminator<'k'>` with the constituents of `A` flattened beside the tag.
 */
export function untaggedMembers(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  const members = type.isIntersection() ? type.types : [type];
  return members.filter((member) => golemTagName(checker, member.aliasSymbol) !== 'Discriminator');
}

/** The tag key a `Discriminator` tag in the checker's type names, or undefined when the type carries none. It runs no other tag reader. */
export function checkerDiscriminator(context: TagAnalysisContext, type: ts.Type): { readonly key: string; readonly defaultType?: ts.Type } | undefined {
  const members = type.isIntersection() ? type.types : [type];
  const tag = members.find((member) => golemTagName(context.checker, member.aliasSymbol) === 'Discriminator');
  const read = tag ? parseCheckerTag(context, tag) : undefined;
  return read?.discriminator === undefined ? undefined : { key: read.discriminator, ...(read.discriminatorDefault ? { defaultType: read.discriminatorDefault } : {}) };
}

/** Whether a type carries a TSerde tag: the tag type itself or a member of an intersection. It reads aliases only, so it runs no tag reader. */
export function carriesSerdeTag(checker: ts.TypeChecker, type: ts.Type): boolean {
  return golemTagName(checker, type.aliasSymbol) === 'TSerde' || (type.isIntersection() && type.types.some((member) => carriesSerdeTag(checker, member)));
}

/**
 * Whether a library or an ambient declaration file declares `symbol`. A `declare global` block in the user's source
 * augments such a symbol and does not change that; a type that only the user's own source declares is not one.
 */
export function isAmbientOrGlobalSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) return true;
  const declarations = symbol.declarations ?? [];
  return declarations.length === 0 || declarations.some((declaration) => declaration.getSourceFile().isDeclarationFile);
}

export function isDateType(checker: ts.TypeChecker, type: ts.Type): boolean {
  const symbol = type.getSymbol?.() ?? type.aliasSymbol;
  if (!symbol) return checker.typeToString(type) === 'Date';
  // Only the global Date is a date: a class or interface the user declares under that name keeps its own shape.
  const name = symbol.getName();
  return name === 'Date' && isAmbientOrGlobalSymbol(symbol);
}

function emptyBase(node: ts.TypeNode): TagReadResult {
  return { baseNode: node, metadata: EMPTY };
}

/**
 * Read phantom tags from a source TypeNode while retaining the untagged node
 * used for structural conversion.  This is intentionally AST-first: checker
 * reduction can make two same-signature predicates indistinguishable.
 */
export function readTags(
  context: TagAnalysisContext,
  node: ts.TypeNode,
  seenAliases = new Set<ts.TypeAliasDeclaration>(),
): TagReadResult {
  if (ts.isParenthesizedTypeNode(node)) return readTags(context, node.type, seenAliases);
  if (ts.isIntersectionTypeNode(node)) {
    let baseNode: ts.TypeNode | undefined;
    let metadata = EMPTY;
    for (const part of node.types) {
      const tag = ts.isTypeReferenceNode(part) ? parseTag(context, part) : undefined;
      if (tag) {
        metadata = mergeMetadata(context, part, metadata, tag);
        continue;
      }
      const nested = readTags(context, part, seenAliases);
      baseNode ??= nested.baseNode;
      metadata = mergeMetadata(context, part, metadata, nested.metadata);
    }
    return baseNode ? { baseNode, metadata } : emptyBase(node);
  }
  if (ts.isTypeReferenceNode(node)) {
    const tag = parseTag(context, node);
    if (tag) {
      throw context.diagnostic(node, '1045', `${node.getText()} must be intersected with a model value type.`);
    }
    const symbol = targetSymbol(context.checker, context.checker.getSymbolAtLocation(node.typeName));
    const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
    if (declaration && !seenAliases.has(declaration)) {
      const next = new Set(seenAliases);
      next.add(declaration);
      const parameters = declaration.typeParameters ?? [];
      const nestedContext: TagAnalysisContext = parameters.length === 0 ? context : {
        ...context,
        aliasUseSite: {
          // The outermost reference is concrete; inner references may name outer parameters.
          node: context.aliasUseSite?.node ?? node,
          type: context.aliasUseSite?.type ?? context.checker.getTypeFromTypeNode(node),
          parameters: new Set([
            ...(context.aliasUseSite?.parameters ?? []),
            ...parameters.map((parameter) => context.checker.getSymbolAtLocation(parameter.name)).filter((s): s is ts.Symbol => s !== undefined),
          ]),
        },
      };
      const nested = readTags(nestedContext, declaration.type, next);
      if (nested.metadata.validations.length || nested.metadata.serde || nested.metadata.constraints.length || nested.metadata.date || nested.metadata.discriminator !== undefined) {
        return nested;
      }
    }
  }
  return emptyBase(node);
}

export function analyzeNode(
  context: TagAnalysisContext,
  type: ts.Type,
  node: ts.TypeNode | undefined,
): TagReadResult {
  const nodeContext: TagAnalysisContext = { ...context, writtenFunctions: newWrittenFunctions() };
  const result = node ? readTags(nodeContext, node) : { baseNode: undefined, metadata: EMPTY };
  const metadata = mergeMetadata(nodeContext, node ?? context.sourceFile, result.metadata, metadataFromType(nodeContext, type));
  if (isDateType(context.checker, type)) {
    return { baseNode: result.baseNode ?? node, metadata: { ...metadata, date: true } };
  }
  // Tags that only the checker type carries mean the node is not where this type comes from (the declaration a
  // mapped property inherits is not the type its template computes), so the node is no untagged base.
  const nodeCarriesTags = result.metadata.validations.length > 0
    || result.metadata.serde !== undefined
    || result.metadata.constraints.length > 0
    || result.metadata.discriminator !== undefined;
  return { baseNode: nodeCarriesTags ? result.baseNode : undefined, metadata };
}
