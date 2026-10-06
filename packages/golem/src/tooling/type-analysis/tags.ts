import path from 'node:path';
import * as ts from '../typescript-ns.js';
import { canonicalFilename, identityRootOf, portableRelativeFilename } from './project.js';
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
}

export interface TagReadResult {
  readonly baseNode?: ts.TypeNode;
  readonly metadata: TagMetadata;
}

export interface TagAnalysisContext {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  /** Absolute project root used to keep emitted binding IDs relocatable. */
  readonly identityRoot?: string;
  /** Whether a file is a model source of the job, so it has a generated companion. */
  readonly isModelSource?: (filename: string) => boolean;
  readonly diagnostic: (node: ts.Node, code: string, message: string) => Error;
  /** Resolve a tag's schema type without executing application code. */
  readonly describeSchema?: (type: ts.Type, node?: ts.TypeNode) => ConstraintSchemaValue;
  readonly aliasUseSite?: AliasUseSite;
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

function mergeMetadata(first: TagMetadata, second: TagMetadata): TagMetadata {
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
  return {
    validations: [...validations.values()],
    constraints: [...constraints.values()],
    ...(first.serde ?? second.serde ? { serde: first.serde ?? second.serde } : {}),
    ...(first.date || second.date ? { date: true } : {}),
  };
}

function literalValue(
  checker: ts.TypeChecker,
  node: ts.TypeNode | undefined,
  expected: 'number' | 'string',
): number | string | undefined {
  if (!node) return undefined;
  if (expected === 'string') {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal.text;
    if (ts.isTemplateLiteralTypeNode(node) && node.templateSpans.length === 0) return node.head.text;
  }
  if (expected === 'number') {
    if (ts.isLiteralTypeNode(node) && ts.isNumericLiteral(node.literal)) return Number(node.literal.text);
    if (
      ts.isLiteralTypeNode(node)
      && ts.isPrefixUnaryExpression(node.literal)
      && node.literal.operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(node.literal.operand)
    ) return -Number(node.literal.operand.text);
  }
  const type = checker.getTypeFromTypeNode(node);
  if (expected === 'number' && (type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    return (type as ts.NumberLiteralType).value;
  }
  if (expected === 'string' && (type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return (type as ts.StringLiteralType).value;
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
function canonicalIdentity(declaration: ts.Declaration, exportName: string, identityRoot?: string): string {
  const filename = declaration.getSourceFile().fileName;
  // A function of a shared folder outside the project keeps one id in every app: it is named from its shared folder.
  const source = identityRoot
    ? portableRelativeFilename(filename, identityRootOf(filename, identityRoot))
    : filename.replace(/\\/g, '/').split('/').pop() ?? 'source.ts';
  return `${source}#${exportName}`;
}

function isGolemTagsSource(filename: string): boolean {
  const normalized = filename.replace(/\\/g, '/');
  return /(?:^|\/)node_modules\/@exprtlabs\/golem\/(?:src|dist)\/tags(?:\.d)?\.(?:c|m)?ts$/.test(normalized)
    || /(?:^|\/)packages\/golem\/(?:src|dist)\/tags(?:\.d)?\.(?:c|m)?ts$/.test(normalized);
}

function isGolemTagSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean {
  const target = targetSymbol(checker, symbol);
  return Boolean(target?.declarations?.some((declaration) => isGolemTagsSource(declaration.getSourceFile().fileName)));
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
  const resolved = packageSpecifier(canonicalFilename(sourceFile.fileName), context.sourceFile.fileName);
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
      `${kind} function ${exportName} is in package ${resolved.packageName}, but no "exports" entry in ${resolved.packageRoot}/package.json reaches ${path.relative(resolved.packageRoot, sourceFile.fileName)}. Export that file from the package.`,
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

function valueBinding(
  context: TagAnalysisContext,
  node: ts.TypeQueryNode,
  kind: 'validation' | 'serialize' | 'deserialize',
): ValueBinding {
  const symbol = symbolAtExpression(context.checker, node.exprName);
  return valueBindingForSymbol(context, symbol, kind, node);
}

function valueBindingFromFunctionType(
  context: TagAnalysisContext,
  type: ts.Type,
  kind: 'validation' | 'serialize' | 'deserialize',
  node: ts.Node,
): ValueBinding {
  const signature = type.getCallSignatures()[0];
  const declaration = signature?.declaration;
  const variable = declaration && ts.isFunctionLike(declaration)
    && (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))
    && ts.isVariableDeclaration(declaration.parent)
    ? declaration.parent
    : undefined;
  const named = variable?.name
    ?? (declaration && (declaration as ts.NamedDeclaration).name);
  const symbol = named ? context.checker.getSymbolAtLocation(named) : undefined;
  return valueBindingForSymbol(context, symbol, kind, node);
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

function synchronousSignature(
  context: TagAnalysisContext,
  node: ts.TypeQueryNode,
  kind: 'validation' | 'serialize' | 'deserialize',
): ts.Signature {
  const type = context.checker.getTypeAtLocation(node.exprName);
  return validateSynchronousSignature(context, type, node, kind);
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
  node: ts.TypeQueryNode,
): ts.Signature {
  const signature = synchronousSignature(context, node, 'validation');
  const returnType = context.checker.getReturnTypeOfSignature(signature);
  const allowed = (candidate: ts.Type): boolean => {
    if ((candidate.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike)) !== 0) return true;
    if (candidate.isUnion()) return candidate.types.every(allowed);
    return false;
  };
  if (!allowed(returnType)) {
    throw context.diagnostic(node, '1048', 'validation must return boolean or string synchronously.');
  }
  return signature;
}

function schemaArgument(
  context: TagAnalysisContext,
  node: ts.TypeNode | undefined,
  owner: ts.Node,
  label: string,
): ConstraintSchemaValue {
  if (!node || !context.describeSchema) {
    throw context.diagnostic(owner, '1043', `${label} requires a representable schema type argument.`);
  }
  return schemaTypeArgument(context, context.checker.getTypeFromTypeNode(node), owner, label, node);
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
  const value = literalValue(context.checker, node, 'string');
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
    try {
      // Generated validators compile JSON Schema patterns with the Unicode flag. Validate the
      // same expression during analysis so malformed metadata never reaches
      // generated output.
      void new RegExp(pattern, 'u');
    } catch {
      throw context.diagnostic(owner, '1044', `${label} requires valid Unicode regular expression keys.`);
    }
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

function tagReferenceName(
  context: TagAnalysisContext,
  node: ts.TypeReferenceNode,
): string | undefined {
  const text = node.typeName.getText();
  const name = ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : node.typeName.right.text;
  const symbolAtNode = context.checker.getSymbolAtLocation(node.typeName);
  if (!isGolemTagSymbol(context.checker, symbolAtNode)) return undefined;
  const symbol = targetSymbol(context.checker, symbolAtNode);
  const symbolName = symbol?.getName();
  const names = new Set([text, name, symbolName].filter((value): value is string => Boolean(value)));
  return [...names].find((candidate) => new Set([
    'TValidation',
    'TSerde',
    'Integer',
    'Minimum',
    'Maximum',
    'Min',
    'Max',
    'ExclusiveMinimum',
    'ExclusiveMaximum',
    'ExclusiveMin',
    'ExclusiveMax',
    'MultipleOf',
    'MinLength',
    'MaxLength',
    'Pattern',
    'Format',
    'MinItems',
    'MaxItems',
    'UniqueItems',
    'MinProperties',
    'MaxProperties',
    'MinProps',
    'MaxProps',
    'Contains',
    'MinContains',
    'MaxContains',
    'PropertyNames',
    'PatternProperties',
    'AdditionalProperties',
    'UnevaluatedProperties',
    'DependentRequired',
    'DependentSchemas',
    'OneOf',
    'Not',
    'IfThenElse',
  ]).has(candidate));
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
  const name = tagReferenceName(context, node);
  if (!name) return undefined;
  const arguments_ = node.typeArguments ?? [];
  if (arguments_.some((argument) => dependsOnAliasParameter(context, argument))) {
    if (name === 'TValidation' || name === 'TSerde') {
      const useSite = context.aliasUseSite!;
      throw context.diagnostic(useSite.node, '1061', `${name} in ${useSite.node.getText()} must name exported functions with typeof, not a type parameter.`);
    }
    return instantiatedTag(context, name);
  }
  if (name === 'TValidation') {
    const predicate = arguments_[0];
    if (!predicate || !ts.isTypeQueryNode(predicate)) {
      throw context.diagnostic(node, '1041', 'TValidation requires typeof an exported synchronous predicate.');
    }
    const signature = validationSignature(context, predicate);
    return {
      validations: [{
        kind: 'validation',
        ...valueBinding(context, predicate, 'validation'),
        parameterType: parameterType(context.checker, signature, node),
      }],
      constraints: [],
    };
  }
  if (name === 'TSerde') {
    const serialize = arguments_[0];
    const deserialize = arguments_[1];
    if (!serialize || !deserialize || !ts.isTypeQueryNode(serialize) || !ts.isTypeQueryNode(deserialize)) {
      throw context.diagnostic(node, '1042', 'TSerde requires typeof serialize and typeof deserialize functions.');
    }
    const serializeSignature = synchronousSignature(context, serialize, 'serialize');
    const deserializeSignature = synchronousSignature(context, deserialize, 'deserialize');
    const serializeBinding = valueBinding(context, serialize, 'serialize');
    const deserializeBinding = valueBinding(context, deserialize, 'deserialize');
    const wireParameter = deserializeSignature.parameters[0];
    const wireDeclaration = wireParameter?.valueDeclaration ?? wireParameter?.declarations?.[0];
    const wireType = wireParameter
      ? context.checker.getTypeOfSymbolAtLocation(wireParameter, wireDeclaration ?? node)
      : context.checker.getUnknownType();
    return {
      validations: [],
      serde: {
        kind: 'serde',
        id: `${serializeBinding.id}\0${deserializeBinding.id}`,
        serialize: serializeBinding,
        deserialize: deserializeBinding,
        modelType: parameterType(context.checker, serializeSignature, node),
        wireType,
        serializeType: context.checker.getReturnTypeOfSignature(serializeSignature),
        deserializeType: context.checker.getReturnTypeOfSignature(deserializeSignature),
      },
      constraints: [],
    };
  }
  const numberValue = (kind: ModelConstraint['kind']): TagMetadata => {
    const value = literalValue(context.checker, arguments_[0], 'number');
    if (value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
      throw context.diagnostic(node, '1043', `${name} requires a finite numeric literal argument.`);
    }
    if (
      (kind === 'minLength' || kind === 'maxLength' || kind === 'minItems' || kind === 'maxItems'
        || kind === 'minProperties' || kind === 'maxProperties' || kind === 'minContains' || kind === 'maxContains')
      && (!Number.isInteger(value) || value < 0)
    ) {
      throw context.diagnostic(node, '1043', `${name} requires a non-negative integer literal argument.`);
    }
    if (kind === 'multipleOf' && value <= 0) {
      throw context.diagnostic(node, '1043', `${name} requires a positive numeric literal argument.`);
    }
    return { validations: [], constraints: [{ kind, value } as ModelConstraint] };
  };
  switch (name) {
    case 'Integer': return { validations: [], constraints: [{ kind: 'integer' }] };
    case 'Minimum':
    case 'Min': return numberValue('minimum');
    case 'Maximum':
    case 'Max': return numberValue('maximum');
    case 'ExclusiveMinimum':
    case 'ExclusiveMin': return numberValue('exclusiveMinimum');
    case 'ExclusiveMaximum':
    case 'ExclusiveMax': return numberValue('exclusiveMaximum');
    case 'MultipleOf': return numberValue('multipleOf');
    case 'MinLength': return numberValue('minLength');
    case 'MaxLength': return numberValue('maxLength');
    case 'MinItems': return numberValue('minItems');
    case 'MaxItems': return numberValue('maxItems');
    case 'MinProperties':
    case 'MinProps': return numberValue('minProperties');
    case 'MaxProperties':
    case 'MaxProps': return numberValue('maxProperties');
    case 'MinContains': return numberValue('minContains');
    case 'MaxContains': return numberValue('maxContains');
    case 'Pattern':
    case 'Format': {
      const value = literalValue(context.checker, arguments_[0], 'string');
      if (typeof value !== 'string') throw context.diagnostic(node, '1044', `${name} requires a string literal argument.`);
      if (name === 'Pattern') {
        try {
          // Generated validators compile JSON Schema patterns with the Unicode flag.  Parse
          // the same expression here so malformed patterns fail before any
          // generated artifact can be written.
          void new RegExp(value, 'u');
        } catch {
          throw context.diagnostic(node, '1044', `${name} requires a valid Unicode regular expression.`);
        }
      }
      return { validations: [], constraints: [{ kind: name === 'Pattern' ? 'pattern' : 'format', value }] };
    }
    case 'UniqueItems': return { validations: [], constraints: [{ kind: 'uniqueItems' }] };
    case 'Contains': return { validations: [], constraints: [{ kind: 'contains', schema: schemaArgument(context, arguments_[0], node, name) }] };
    case 'PropertyNames': return { validations: [], constraints: [{ kind: 'propertyNames', schema: schemaArgument(context, arguments_[0], node, name) }] };
    case 'AdditionalProperties': return { validations: [], constraints: [{ kind: 'additionalProperties', schema: schemaArgument(context, arguments_[0], node, name) }] };
    case 'UnevaluatedProperties': return { validations: [], constraints: [{ kind: 'unevaluatedProperties', schema: schemaArgument(context, arguments_[0], node, name) }] };
    case 'Not': return { validations: [], constraints: [{ kind: 'not', schema: schemaArgument(context, arguments_[0], node, name) }] };
    case 'PatternProperties': {
      const patterns = patternSchemaMap(
        context,
        arguments_[0] ? context.checker.getTypeFromTypeNode(arguments_[0]) : undefined,
        arguments_[0],
        node,
        name,
      );
      return {
        validations: [],
        constraints: Object.entries(patterns).map(([pattern, schema]) => ({ kind: 'patternProperties', pattern, schema })),
      };
    }
    case 'DependentRequired': {
      return {
        validations: [],
        constraints: [{ kind: 'dependentRequired', value: dependentRequiredMap(context, arguments_[0] ? context.checker.getTypeFromTypeNode(arguments_[0]) : undefined, arguments_[0], node) }],
      };
    }
    case 'DependentSchemas': {
      return {
        validations: [],
        constraints: [{ kind: 'dependentSchemas', value: schemaMap(context, arguments_[0] ? context.checker.getTypeFromTypeNode(arguments_[0]) : undefined, arguments_[0], node, name) }],
      };
    }
    case 'OneOf': return { validations: [], constraints: [{ kind: 'oneOf', schemas: schemaList(context, arguments_[0] ? context.checker.getTypeFromTypeNode(arguments_[0]) : undefined, arguments_[0], node, name) }] };
    case 'IfThenElse': {
      const condition = schemaArgument(context, arguments_[0], node, name);
      const thenSchema = schemaArgument(context, arguments_[1], node, name);
      const elseSchema = arguments_[2] ? schemaArgument(context, arguments_[2], node, name) : undefined;
      return {
        validations: [],
        constraints: [{ kind: 'ifThenElse', if: condition, then: thenSchema, ...(elseSchema === undefined ? {} : { else: elseSchema }) }],
      };
    }
    default: return undefined;
  }
}

function checkerLiteralValue(
  checker: ts.TypeChecker,
  type: ts.Type | undefined,
  expected: 'number' | 'string',
): number | string | undefined {
  if (!type) return undefined;
  if (expected === 'number' && (type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    return (type as ts.NumberLiteralType).value;
  }
  if (expected === 'string' && (type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return (type as ts.StringLiteralType).value;
  }
  const text = checker.typeToString(type);
  if (expected === 'number') {
    const value = Number(text);
    return Number.isFinite(value) && text.trim() !== '' ? value : undefined;
  }
  return undefined;
}

function parseCheckerTag(
  context: TagAnalysisContext,
  type: ts.Type,
): TagMetadata | undefined {
  if (!isGolemTagSymbol(context.checker, type.aliasSymbol)) return undefined;
  const name = type.aliasSymbol?.getName();
  if (!name) return undefined;
  const arguments_ = type.aliasTypeArguments ?? [];
  if (name === 'TValidation') {
    const predicateType = arguments_[0];
    if (!predicateType) throw context.diagnostic(type.symbol?.valueDeclaration ?? context.sourceFile, '1041', 'TValidation requires typeof an exported synchronous predicate.');
    const signature = validateSynchronousSignature(context, predicateType, context.sourceFile, 'validation');
    const returnType = context.checker.getReturnTypeOfSignature(signature);
    const allowed = (candidate: ts.Type): boolean => {
      if ((candidate.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike)) !== 0) return true;
      return candidate.isUnion() && candidate.types.every(allowed);
    };
    if (!allowed(returnType)) throw context.diagnostic(context.sourceFile, '1048', 'validation must return boolean or string synchronously.');
    return {
      validations: [{
        kind: 'validation',
        ...valueBindingFromFunctionType(context, predicateType, 'validation', context.sourceFile),
        parameterType: parameterType(context.checker, signature, context.sourceFile),
      }],
      constraints: [],
    };
  }
  if (name === 'TSerde') {
    const serializeType = arguments_[0];
    const deserializeType = arguments_[1];
    if (!serializeType || !deserializeType) throw context.diagnostic(context.sourceFile, '1042', 'TSerde requires typeof serialize and typeof deserialize functions.');
    const serializeSignature = validateSynchronousSignature(context, serializeType, context.sourceFile, 'serialize');
    const deserializeSignature = validateSynchronousSignature(context, deserializeType, context.sourceFile, 'deserialize');
    const serialize = valueBindingFromFunctionType(context, serializeType, 'serialize', context.sourceFile);
    const deserialize = valueBindingFromFunctionType(context, deserializeType, 'deserialize', context.sourceFile);
    const modelParameter = serializeSignature.parameters[0];
    const modelDeclaration = modelParameter?.valueDeclaration ?? modelParameter?.declarations?.[0];
    const wireParameter = deserializeSignature.parameters[0];
    const wireDeclaration = wireParameter?.valueDeclaration ?? wireParameter?.declarations?.[0];
    return {
      validations: [],
      serde: {
        kind: 'serde',
        id: `${serialize.id}\0${deserialize.id}`,
        serialize,
        deserialize,
        modelType: modelParameter
          ? context.checker.getTypeOfSymbolAtLocation(modelParameter, modelDeclaration ?? context.sourceFile)
          : context.checker.getUnknownType(),
        wireType: wireParameter
          ? context.checker.getTypeOfSymbolAtLocation(wireParameter, wireDeclaration ?? context.sourceFile)
          : context.checker.getUnknownType(),
        serializeType: context.checker.getReturnTypeOfSignature(serializeSignature),
        deserializeType: context.checker.getReturnTypeOfSignature(deserializeSignature),
      },
      constraints: [],
    };
  }
  const numberConstraint = (kind: ModelConstraint['kind']): TagMetadata => {
    const value = checkerLiteralValue(context.checker, arguments_[0], 'number');
    if (value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
      throw context.diagnostic(context.sourceFile, '1043', `${name} requires a finite numeric literal argument.`);
    }
    if (
      (kind === 'minLength' || kind === 'maxLength' || kind === 'minItems' || kind === 'maxItems'
        || kind === 'minProperties' || kind === 'maxProperties' || kind === 'minContains' || kind === 'maxContains')
      && (!Number.isInteger(value) || value < 0)
    ) {
      throw context.diagnostic(context.sourceFile, '1043', `${name} requires a non-negative integer literal argument.`);
    }
    if (kind === 'multipleOf' && value <= 0) {
      throw context.diagnostic(context.sourceFile, '1043', `${name} requires a positive numeric literal argument.`);
    }
    return { validations: [], constraints: [{ kind, value } as ModelConstraint] };
  };
  switch (name) {
    case 'Integer': return { validations: [], constraints: [{ kind: 'integer' }] };
    case 'Minimum':
    case 'Min': return numberConstraint('minimum');
    case 'Maximum':
    case 'Max': return numberConstraint('maximum');
    case 'ExclusiveMinimum':
    case 'ExclusiveMin': return numberConstraint('exclusiveMinimum');
    case 'ExclusiveMaximum':
    case 'ExclusiveMax': return numberConstraint('exclusiveMaximum');
    case 'MultipleOf': return numberConstraint('multipleOf');
    case 'MinLength': return numberConstraint('minLength');
    case 'MaxLength': return numberConstraint('maxLength');
    case 'MinItems': return numberConstraint('minItems');
    case 'MaxItems': return numberConstraint('maxItems');
    case 'MinProperties':
    case 'MinProps': return numberConstraint('minProperties');
    case 'MaxProperties':
    case 'MaxProps': return numberConstraint('maxProperties');
    case 'MinContains': return numberConstraint('minContains');
    case 'MaxContains': return numberConstraint('maxContains');
    case 'Pattern':
    case 'Format': {
      const value = checkerLiteralValue(context.checker, arguments_[0], 'string');
      if (typeof value !== 'string') throw context.diagnostic(context.sourceFile, '1044', `${name} requires a string literal argument.`);
      if (name === 'Pattern') {
        try {
          void new RegExp(value, 'u');
        } catch {
          throw context.diagnostic(context.sourceFile, '1044', `${name} requires a valid Unicode regular expression.`);
        }
      }
      return { validations: [], constraints: [{ kind: name === 'Pattern' ? 'pattern' : 'format', value }] };
    }
    case 'UniqueItems': return { validations: [], constraints: [{ kind: 'uniqueItems' }] };
    case 'Contains': return { validations: [], constraints: [{ kind: 'contains', schema: schemaTypeArgument(context, arguments_[0], context.sourceFile, name) }] };
    case 'PropertyNames': return { validations: [], constraints: [{ kind: 'propertyNames', schema: schemaTypeArgument(context, arguments_[0], context.sourceFile, name) }] };
    case 'AdditionalProperties': return { validations: [], constraints: [{ kind: 'additionalProperties', schema: schemaTypeArgument(context, arguments_[0], context.sourceFile, name) }] };
    case 'UnevaluatedProperties': return { validations: [], constraints: [{ kind: 'unevaluatedProperties', schema: schemaTypeArgument(context, arguments_[0], context.sourceFile, name) }] };
    case 'Not': return { validations: [], constraints: [{ kind: 'not', schema: schemaTypeArgument(context, arguments_[0], context.sourceFile, name) }] };
    case 'PatternProperties': {
      const patterns = patternSchemaMap(
        context,
        arguments_[0],
        undefined,
        context.sourceFile,
        name,
      );
      return {
        validations: [],
        constraints: Object.entries(patterns).map(([pattern, schema]) => ({ kind: 'patternProperties', pattern, schema })),
      };
    }
    case 'DependentRequired': return {
      validations: [],
      constraints: [{ kind: 'dependentRequired', value: dependentRequiredMap(context, arguments_[0], undefined, context.sourceFile) }],
    };
    case 'DependentSchemas': return {
      validations: [],
      constraints: [{ kind: 'dependentSchemas', value: schemaMap(context, arguments_[0], undefined, context.sourceFile, name) }],
    };
    case 'OneOf': return {
      validations: [],
      constraints: [{ kind: 'oneOf', schemas: schemaList(context, arguments_[0], undefined, context.sourceFile, name) }],
    };
    case 'IfThenElse': {
      const condition = schemaTypeArgument(context, arguments_[0], context.sourceFile, name);
      const thenSchema = schemaTypeArgument(context, arguments_[1], context.sourceFile, name);
      const elseSchema = arguments_[2] ? schemaTypeArgument(context, arguments_[2], context.sourceFile, name) : undefined;
      return {
        validations: [],
        constraints: [{ kind: 'ifThenElse', if: condition, then: thenSchema, ...(elseSchema === undefined ? {} : { else: elseSchema }) }],
      };
    }
    default: return undefined;
  }
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
      (metadata, member) => mergeMetadata(metadata, metadataFromType(context, member, seen)),
      EMPTY,
    );
  }
  return EMPTY;
}

export function isDateType(checker: ts.TypeChecker, type: ts.Type): boolean {
  const symbol = type.getSymbol?.() ?? type.aliasSymbol;
  return symbol?.getName() === 'Date' || checker.typeToString(type) === 'Date';
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
        metadata = mergeMetadata(metadata, tag);
        continue;
      }
      const nested = readTags(context, part, seenAliases);
      baseNode ??= nested.baseNode;
      metadata = mergeMetadata(metadata, nested.metadata);
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
      if (nested.metadata.validations.length || nested.metadata.serde || nested.metadata.constraints.length || nested.metadata.date) {
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
  const result = node ? readTags(context, node) : { baseNode: undefined, metadata: EMPTY };
  const metadata = mergeMetadata(result.metadata, metadataFromType(context, type));
  if (isDateType(context.checker, type)) {
    return { baseNode: result.baseNode ?? node, metadata: { ...metadata, date: true } };
  }
  return { baseNode: result.baseNode, metadata };
}

export function mergeTagMetadata(...metadata: readonly TagMetadata[]): TagMetadata {
  return metadata.reduce(mergeMetadata, EMPTY);
}
