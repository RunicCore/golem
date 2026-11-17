import path from 'node:path';
import { displayPath } from '../generator-core.js';
import { hasLocalForm, localFormMessage } from '../names.js';
import * as ts from '../typescript-ns.js';
import { canonicalFilename, portableRelativeFilename } from './project.js';
import { nearestManifest, packageSpecifier } from '../package-specifier.js';
import { ManifestError } from '../package-specifier.js';
import type { PackageManifest } from '../package-specifier.js';
import { canonicalConstraintKey } from '../schema.js';
import type { ConstraintSchemaValue, ModelConstraint } from '../schema.js';
import type { ImportedFunction } from '../../model-registry.js';
export type { SerdeFunctions } from '../../model-registry.js';
export type { ConstraintSchemaValue, ModelConstraint } from '../schema.js';

export interface ValueBinding extends ImportedFunction {
  readonly declaration: ts.Declaration;
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
  /** The nodes that declare the wire type: the tags on it name their functions. */
  readonly wireNodes: readonly ts.TypeNode[];
  /** The output types used to verify the pair at the model boundary. */
  readonly serializeType: ts.Type;
  readonly deserializeType: ts.Type;
}

export interface TagMetadata {
  readonly validations: readonly ValidationBinding[];
  readonly serde?: SerdeBinding;
  readonly constraints: readonly ModelConstraint[];
  /** The property a `Discriminator<Key>` tag names as the tag of a model object union. */
  readonly discriminator?: string;
  /** The `Default` type argument of that tag, when it names a variant. */
  readonly discriminatorDefault?: ts.Type;
}

/** Whether a tag read holds a validation, a serde or a constraint: what a descriptor keeps. A `Discriminator` names the tag key of a union, and the descriptor of a variant holds none of it. */
export function hasDescriptorTags(metadata: Pick<TagMetadata, 'validations' | 'constraints'> & { readonly serde?: unknown }): boolean {
  return metadata.validations.length > 0 || metadata.serde !== undefined || metadata.constraints.length > 0;
}

/** Whether a tag read holds any tag, a `Discriminator` included. */
export function hasTagMetadata(metadata: Pick<TagMetadata, 'validations' | 'constraints' | 'discriminator'> & { readonly serde?: unknown }): boolean {
  return hasDescriptorTags(metadata) || metadata.discriminator !== undefined;
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
  /** Whether a file is a default library file of the program: it holds no tag of the user, so the scan of the written functions leaves it unread. Unset: no file is one. */
  readonly isDefaultLibraryFile?: (file: ts.SourceFile) => boolean;
  /** Whether a file is a model source of the job, so it has a generated companion. */
  readonly isModelSource?: (filename: string) => boolean;
  readonly diagnostic: (node: ts.Node, code: string, message: string) => Error;
  /** Resolve a tag's schema type without executing application code. */
  readonly describeSchema?: (type: ts.Type, node: ts.TypeNode | undefined) => ConstraintSchemaValue;
  readonly aliasUseSite?: AliasUseSite;
  /**
   * The functions that the source nodes of the field write after `typeof`, by their type (`recordWrittenFunction`, `reach`). The checker read of the
   * same field names a function from its type alone, and one type can belong to several functions (`const b: typeof a`, a shared alias).
   * Within one role, a type written with two different symbols maps to null and names no function.
   */
  readonly writtenFunctions?: WrittenFunctions;
  /** The functions that the tags of the program write, read on the first call. */
  readonly functionIndex: () => FunctionIndex;
}

type FunctionRole = 'validation' | 'serialize' | 'deserialize';
export interface WrittenFunctions {
  readonly validation: Map<ts.Type, ts.Symbol | null>;
  readonly serialize: Map<ts.Type, ts.Symbol | null>;
  readonly deserialize: Map<ts.Type, ts.Symbol | null>;
  /** The nodes that this field was read from. */
  readonly sources: readonly ts.Node[];
  /** The read of `sources` that finds the functions of the tags in them. It runs once, before the first tag read from the checker needs it. */
  walk: Walk | undefined;
}

/** Generated validators compile JSON Schema patterns with the Unicode flag; analysis parses each pattern the same way, so a malformed one fails before any output is written. */
function isUnicodePattern(pattern: string): boolean {
  try {
    void new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

/** A registry for one field: the functions that the nodes it was read from write after `typeof`, found by `reach`. */
function newWrittenFunctions(sources: readonly ts.Node[]): WrittenFunctions {
  return { validation: new Map(), serialize: new Map(), deserialize: new Map(), sources, walk: undefined };
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
      throw context.diagnostic(
        at,
        '1042',
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
  if (expected === 'number' && ts.isNumberLiteralType(type)) return type.value;
  if (expected === 'string' && ts.isStringLiteralType(type)) return type.value;
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

/** The owning package of each directory, for each type checker: a checker lives for one run, so a package.json edited in watch mode is read again by the next one. */
const ownersByChecker = new WeakMap<ts.TypeChecker, Map<string, PackageManifest | undefined>>();

/** Whether `filename` is the golem source or declaration file named `stem` (`tags`, `model`), in a package install or in this workspace. `owners` remembers the owning package of each directory. */
export function isGolemSourceFile(filename: string, stem: 'tags' | 'model', owners?: Map<string, PackageManifest | undefined>): boolean {
  let owner: PackageManifest | undefined;
  // A package.json above the file that cannot be read gives the file no owner: a symbol of an app file is no golem tag, and the run goes on.
  try { owner = nearestManifest(filename, owners); }
  catch (error) { if (error instanceof ManifestError) return false; throw error; }
  if (owner?.name !== '@exprtlabs/golem') return false;
  const file = portableRelativeFilename(filename, owner.root);
  return ['src', 'dist'].some((directory) => ['ts', 'mts', 'cts', 'd.ts', 'd.mts', 'd.cts'].some((extension) => file === `${directory}/${stem}.${extension}`));
}

function isGolemTagSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean {
  const target = targetSymbol(checker, symbol);
  let owners = ownersByChecker.get(checker);
  if (!owners) ownersByChecker.set(checker, owners = new Map());
  return Boolean(target?.declarations?.some((declaration) => isGolemSourceFile(declaration.getSourceFile().fileName, 'tags', owners)));
}

/** The name node of the declaration of `property`: a computed key such as `[sym]` for a property keyed by a symbol. */
export function propertyKey(property: ts.Symbol): ts.PropertyName | undefined {
  return (property.valueDeclaration ?? property.declarations?.[0])?.name;
}

/** Whether `property` is the key of a golem tag: a property named by one of the unique symbols that tags.ts declares. */
export function isGolemTagKey(checker: ts.TypeChecker, property: ts.Symbol): boolean {
  const key = propertyKey(property);
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
  // Only a validation function is imported under its own name; the serde functions are imported under an alias.
  if (kind === 'validation' && hasLocalForm(exportName)) throw context.diagnostic(node, '1088', localFormMessage(exportName, `The ${kind} function`));
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

/** The functions that the arguments of each tag write after `typeof`, in the order of the roles. */
const TAG_FUNCTION_ROLES: ReadonlyMap<string, readonly FunctionRole[]> = new Map([
  ['TValidation', ['validation']],
  ['TSerde', ['serialize', 'deserialize']],
]);

function recordWrittenFunction(context: TagAnalysisContext, role: FunctionRole, query: ts.TypeQueryNode): void {
  const registry = context.writtenFunctions?.[role];
  const written = writtenFunction(context.checker, query);
  if (!registry || !written) return;
  const known = registry.get(written.type);
  if (known !== null) registry.set(written.type, known === undefined || known === written.symbol ? written.symbol : null);
}

/** Records the `typeof` arguments of a TValidation or TSerde reference by the role of each argument. */
function recordTagFunctions(context: TagAnalysisContext, typeArguments: readonly ts.TypeNode[] | undefined, name: string): void {
  TAG_FUNCTION_ROLES.get(name)?.forEach((role, index) => {
    const argument = typeArguments?.[index];
    if (argument && ts.isTypeQueryNode(argument)) recordWrittenFunction(context, role, argument);
  });
}

/** The type nodes that declare `property`, also when a mapped type or an intersection copied the declaration. */
export function declaredPropertyNodes(checker: ts.TypeChecker, property: ts.Symbol): readonly ts.TypeNode[] {
  return propertyDeclarations(checker, property).flatMap(declaration => (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.type ? [declaration.type] : []);
}

/** The nodes that write the tags of `property`: its type nodes, and each declaration that shows none and infers its type (`get label() { return tagged(); }`). */
export function propertyTagSources(checker: ts.TypeChecker, property: ts.Symbol): readonly ts.Node[] {
  return [...declaredPropertyNodes(checker, property), ...propertyDeclarations(checker, property).filter(infersItsType)];
}

/** The members that declare `property`: its own, or those of the property that a mapped type copies it from. */
export function propertyDeclarations(checker: ts.TypeChecker, property: ts.Symbol): readonly ts.Node[] {
  return property.declarations ?? checker.getRootSymbols(property).flatMap(root => root.declarations ?? []);
}

/** Whether only a default library file declares `symbol`: a built-in type holds no tag of the user. */
export function isDeclaredByDefaultLibrary(symbol: ts.Symbol | undefined, isDefaultLibraryFile: (file: ts.SourceFile) => boolean): boolean {
  const declarations = symbol?.declarations ?? [];
  return declarations.length > 0 && declarations.every(declaration => isDefaultLibraryFile(declaration.getSourceFile()));
}

/** Whether `node` is a value or a member that writes no type node, so the checker supplies its type (`held = tagged()`): a tag in it shows no `typeof` to the walk. */
function infersItsType(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) {
    return node.type === undefined;
  }
  return ts.isPropertyAssignment(node) || ts.isBindingElement(node);
}

/** Whether `node` names a base class that a call computes (`class Sub extends mixin(Base)`): it shows no declaration of its base, so the walk reads the members of the base type instead. */
function computesItsBase(node: ts.ExpressionWithTypeArguments): boolean {
  return !ts.isIdentifier(node.expression) && !ts.isPropertyAccessExpression(node.expression);
}

/** The properties that `T['key']` names: each string literal of its index type, as the checker finds it in the type of `T`. */
function indexedProperties(checker: ts.TypeChecker, node: ts.IndexedAccessTypeNode): readonly ts.Symbol[] {
  const object = checker.getTypeFromTypeNode(node.objectType);
  const keys = checker.getTypeFromTypeNode(node.indexType);
  return (keys.isUnion() ? keys.types : [keys]).flatMap((key) => {
    const property = ts.isStringLiteralType(key) ? checker.getPropertyOfType(object, key.value) : undefined;
    return property ? [property] : [];
  });
}

/** The file, line and column where `at` starts, to name it in a message. */
export function sourceLocation(at: ts.Node): string {
  const sourceFile = at.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile));
  return `${displayPath(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}`;
}

/** The first line of a declaration, cut to 60 characters, to name it in a message. */
function firstLine(text: string): string {
  const [line = ''] = text.split('\n');
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/** The functions that tags of the program write for one function type, each with the `typeof` that writes it. */
export type FunctionWriters = ReadonlyMap<ts.Symbol, ts.Node>;

/**
 * The functions that the tag references of the program write, read once (`functionIndexOf`). A tag type (`TValidation<F>`, `TSerde<S, D>`) exists
 * only where a tag reference is written, in a file of the program or a declaration file of a package, under its own name or any rename of it:
 * the references are found by symbol. `complete` says that every function argument of every reference is a direct `typeof` of a function. Then
 * `writers` holds every function that any tag type of the program can name, and the writers of one function type are all the functions that a
 * tag of that type can name. When one argument is another type (a type parameter, an indexed access, an alias), a function can
 * reach a tag type by a call, an alias or an index, and `writers` is no more than a list of what the program writes directly.
 */
export interface FunctionIndex {
  readonly complete: boolean;
  readonly writers: ReadonlyMap<ts.Type, FunctionWriters>;
}

/** The function that `query` names after `typeof`, with its type; a name that is no function, or has no declaration, is none. */
function writtenFunction(checker: ts.TypeChecker, query: ts.TypeQueryNode): { readonly symbol: ts.Symbol; readonly type: ts.Type } | undefined {
  // Two names of one function (`export { validate as check }`, `const alias = validate`) are one function.
  const symbol = canonicalValue(checker, symbolAtExpression(checker, query.exprName))?.symbol;
  const type = symbol ? checker.getTypeAtLocation(query.exprName) : undefined;
  return symbol && type && type.getCallSignatures().length > 0 ? { symbol, type } : undefined;
}

/** The name and the type arguments of a node that names a type: a type reference, or an import type with a qualifier (`import('...').T<A>`). */
function typeReferenceOf(node: ts.Node): { readonly name: ts.Node; readonly typeArguments: readonly ts.TypeNode[] | undefined } | undefined {
  if (ts.isTypeReferenceNode(node)) return { name: node.typeName, typeArguments: node.typeArguments };
  return ts.isImportTypeNode(node) && node.qualifier ? { name: node.qualifier, typeArguments: node.typeArguments } : undefined;
}

const PARAMETER_PROPERTY_MODIFIERS: readonly ts.SyntaxKind[] = [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.OverrideKeyword, ts.SyntaxKind.ReadonlyKeyword];

/**
 * The members of a class that its instance type holds. The static members and the constructor belong to the class value (`typeof Class`) and are no part
 * of an instance; only a parameter property of the constructor is a field of it.
 */
function instanceMembersOf(declaration: ts.ClassDeclaration | ts.InterfaceDeclaration): readonly ts.Node[] {
  return declaration.members.flatMap((member): readonly ts.Node[] => {
    if (ts.isConstructorDeclaration(member)) return member.parameters.filter(parameter => (ts.getModifiers(parameter) ?? []).some(modifier => PARAMETER_PROPERTY_MODIFIERS.includes(modifier.kind)));
    return ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ? [] : [member];
  });
}

/** A declaration that gives its name no type meaning: a variable, a function, or a namespace (a class, an enum, an interface and a type alias carry one). */
function isValueOrNamespace(declaration: ts.Declaration): boolean {
  return ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration) || ts.isModuleDeclaration(declaration);
}

function buildFunctionIndex(checker: ts.TypeChecker, files: readonly ts.SourceFile[]): FunctionIndex {
  const writers = new Map<ts.Type, Map<ts.Symbol, ts.Node>>();
  let complete = true;
  const visit = (node: ts.Node): void => {
    // `import('...').TValidation<F>` names its tag by the qualifier of the import type.
    const reference = typeReferenceOf(node) ?? (ts.isExpressionWithTypeArguments(node) ? { name: node.expression, typeArguments: node.typeArguments } : undefined);
    const tagName = reference?.typeArguments ? golemTagName(checker, checker.getSymbolAtLocation(reference.name)) : undefined;
    TAG_FUNCTION_ROLES.get(tagName ?? '')?.forEach((_role, position) => {
      const argument = reference?.typeArguments?.[position];
      const written = argument && ts.isTypeQueryNode(argument) ? writtenFunction(checker, argument) : undefined;
      if (!argument || !written) {
        complete = false;
        return;
      }
      const own = writers.get(written.type) ?? new Map<ts.Symbol, ts.Node>();
      writers.set(written.type, own);
      if (!own.has(written.symbol)) own.set(written.symbol, argument);
    });
    ts.forEachChild(node, visit);
  };
  for (const file of files) visit(file);
  return { complete, writers };
}

/** For a context that reads no function tag (a `Discriminator` read): it knows no function, so a function tag that it met would refuse. */
export const NO_FUNCTIONS_KNOWN = (): FunctionIndex => ({ complete: false, writers: new Map() });

const indexByChecker = new WeakMap<ts.TypeChecker, FunctionIndex>();

/** The index of the program that `checker` belongs to. It is read on the first call and shared by every builder and job of the checker. */
export function functionIndexOf(checker: ts.TypeChecker, programFiles: () => readonly ts.SourceFile[]): FunctionIndex {
  const known = indexByChecker.get(checker);
  if (known) return known;
  const index = buildFunctionIndex(checker, programFiles());
  indexByChecker.set(checker, index);
  return index;
}

/** What one walk has read: each node once, the type parameters that the declarations it entered bind, and the first node that it could not read. */
export interface Walk {
  readonly nodes: Set<ts.Node>;
  readonly bound: Set<ts.Symbol>;
  unreadable: { readonly node: ts.Node; readonly reason: string } | undefined;
}

const INFERRED = 'whose type golem infers';

/**
 * Whether `node` holds no other node that can hold a tag: a name, a literal, a keyword type such as `string`, an enum member (`Color.Red`), or a class
 * static block, which carries no type.
 */
function holdsNothing(node: ts.Node): boolean {
  return ts.isIdentifier(node) || ts.isLiteralTypeNode(node) || ts.isEnumDeclaration(node) || ts.isEnumMember(node) || ts.isClassStaticBlockDeclaration(node)
    || (ts.isTypeNode(node) && ts.forEachChild(node, () => true) === undefined);
}

/**
 * Reads everything that `node` reaches, to the `typeof` of every tag in it: through type aliases, interfaces, classes and their base classes,
 * `typeof` a variable, a property that `T['key']` names, the exported values of a module or namespace that `typeof` or an import type names, and the parts of conditional, mapped and compound types. A default library file holds
 * no tag of the user and stays unread. These are the kinds that it follows; any other kind stops the read at that node (`unreadable`).
 * So does a value or member that shows no type node (`held = tagged()`): its tag shows no `typeof`. So does a type parameter that no declaration
 * of the read binds, and a tag whose function is written without `typeof`. Each node is read once.
 */
function reach(context: TagAnalysisContext, walk: Walk, node: ts.Node): void {
  if (walk.nodes.has(node)) return;
  walk.nodes.add(node);
  const { checker } = context;
  const next = (child: ts.Node | undefined): void => {
    if (child) reach(context, walk, child);
  };
  const nextAll = (children: readonly (ts.Node | undefined)[] | undefined): void => children?.forEach(next);
  const stop = (reason: string): void => {
    walk.unreadable ??= { node, reason };
  };
  const reachDeclarations = (declarations: readonly ts.Node[]): void => {
    for (const declaration of declarations) {
      if (!context.isDefaultLibraryFile?.(declaration.getSourceFile())) next(declaration);
    }
  };
  const reachDeclarationsOf = (symbol: ts.Symbol | undefined): void => reachDeclarations(targetSymbol(checker, symbol)?.declarations ?? []);
  // What `typeof Class` holds beside the members of an instance, which the declaration of the class reads: the static members and the constructors, those of its base classes too.
  const reachStaticSideOf = (symbol: ts.Symbol | undefined): void => {
    if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0) return;
    const value = checker.getTypeOfSymbolAtLocation(symbol, node);
    for (const property of checker.getPropertiesOfType(value)) reachDeclarations(propertyDeclarations(checker, property));
    reachDeclarations(value.getConstructSignatures().flatMap(signature => signature.declaration ?? []));
  };
  // The exported values of a module or a namespace: what `typeof ns` and `typeof import('...')` name. An export that is only a type holds no value of it.
  // An export that is a namespace or a module (`export * as sub`) is read at its own declaration, which comes back here.
  const reachExportsOf = (symbol: ts.Symbol | undefined): void => {
    if (!symbol || (symbol.flags & ts.SymbolFlags.Module) === 0) return;
    for (const exported of checker.getExportsOfModule(symbol)) {
      const target = targetSymbol(checker, exported);
      if (target && (target.flags & ts.SymbolFlags.Value) !== 0) {
        reachDeclarationsOf(target);
        reachStaticSideOf(target);
      }
    }
  };
  if (holdsNothing(node)) return;
  if (infersItsType(node)) return stop(INFERRED);
  const reference = typeReferenceOf(node);
  if (ts.isParenthesizedTypeNode(node) || ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node) || ts.isTypeOperatorNode(node) || ts.isNamedTupleMember(node) || ts.isTypePredicateNode(node)) {
    next(node.type);
  } else if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    nextAll(node.types);
  } else if (ts.isArrayTypeNode(node)) {
    next(node.elementType);
  } else if (ts.isTemplateLiteralTypeNode(node)) {
    nextAll(node.templateSpans.map(span => span.type));
  } else if (ts.isTupleTypeNode(node)) {
    nextAll(node.elements);
  } else if (ts.isConditionalTypeNode(node)) {
    nextAll([node.checkType, node.extendsType, node.trueType, node.falseType]);
  } else if (ts.isMappedTypeNode(node)) {
    nextAll([node.typeParameter, node.nameType, node.type]);
  } else if (ts.isTypeLiteralNode(node)) {
    nextAll(node.members);
  } else if (ts.isInferTypeNode(node)) {
    next(node.typeParameter);
  } else if (ts.isTypeParameterDeclaration(node)) {
    const symbol = checker.getSymbolAtLocation(node.name);
    if (symbol) walk.bound.add(symbol);
    next(node.constraint);
    next(ts.typeParameterDefault(node));
  } else if (reference) {
    const symbol = checker.getSymbolAtLocation(reference.name);
    const tag = golemTag(checker, symbol);
    if (tag) {
      const roles = TAG_FUNCTION_ROLES.get(tag.name) ?? [];
      recordTagFunctions(context, reference.typeArguments, tag.name);
      reference.typeArguments?.forEach((argument, position) => {
        if (position >= roles.length) next(argument);
        else if (!ts.isTypeQueryNode(argument)) stop('which writes the function of this tag without `typeof`');
      });
    } else if (symbol?.declarations?.some(ts.isTypeParameterDeclaration)) {
      if (!walk.bound.has(symbol)) stop('which names a type parameter that the read does not bind');
    } else {
      // A type reference names the type meaning only: a value or a namespace that shares its name (`const Mode` beside `type Mode`) is no part of the type.
      reachDeclarations((targetSymbol(checker, symbol)?.declarations ?? []).filter(declaration => !isValueOrNamespace(declaration)));
      nextAll(reference.typeArguments);
    }
  } else if (ts.isModuleDeclaration(node)) {
    reachExportsOf(checker.getSymbolAtLocation(node.name));
  } else if (ts.isSourceFile(node)) {
    reachExportsOf(checker.getSymbolAtLocation(node));
  } else if (ts.isImportTypeNode(node)) {
    // An import type with no qualifier (the qualified one is `reference`): `typeof import('...')` is the module, and `import('...')` of a module that writes `export =` is the type that it exports.
    const target = checker.getTypeFromTypeNode(node).getSymbol();
    if (!target) stop('whose type names no declaration');
    reachDeclarationsOf(target);
    reachExportsOf(target);
    nextAll(node.typeArguments);
  } else if (ts.isTypeAliasDeclaration(node)) {
    nextAll(node.typeParameters);
    next(node.type);
  } else if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    nextAll(node.typeParameters);
    nextAll(node.heritageClauses?.flatMap(clause => clause.types));
    // A class reached here is read as an instance type, or as a base of one: `reachStaticSideOf` reads the rest of it for `typeof Class`.
    nextAll(instanceMembersOf(node));
  } else if (ts.isExpressionWithTypeArguments(node)) {
    reachDeclarationsOf(checker.getSymbolAtLocation(node.expression));
    // A call shows no declaration of its base: each member is read where it is written.
    if (computesItsBase(node)) {
      for (const property of checker.getPropertiesOfType(checker.getTypeAtLocation(node))) nextAll(propertyTagSources(checker, property));
    }
    nextAll(node.typeArguments);
  } else if (ts.isTypeQueryNode(node)) {
    const target = targetSymbol(checker, symbolAtExpression(checker, node.exprName));
    const declaration = declarationOf(target);
    if (declaration) next(declaration);
    else stop('which names no declaration');
    reachStaticSideOf(target);
    reachExportsOf(target);
  } else if (ts.isIndexedAccessTypeNode(node)) {
    // `Box['g']` names one member: the other members of `Box` are fields beside it and stay unread.
    // A property of a type parameter is read from its constraint, not from the type that the use site gives it; a property with no declaration (a renamed key) shows no node to read.
    const named = indexedProperties(checker, node);
    const sources = named.map(property => propertyTagSources(checker, property));
    if ((checker.getTypeFromTypeNode(node.objectType).flags & ts.TypeFlags.TypeParameter) !== 0) stop('whose object type is a type parameter');
    else if (named.length === 0) stop('whose index names no property of the type');
    // A property that no node declares (a renamed key of a mapped type) has a type that the checker computes: no node shows its tag.
    else if (sources.some(own => own.length === 0)) stop(INFERRED);
    nextAll(sources.flat());
  } else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)) {
    next(node.type);
  } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isFunctionDeclaration(node) || ts.isCallSignatureDeclaration(node) || ts.isConstructSignatureDeclaration(node) || ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
    nextAll(node.typeParameters);
    nextAll(node.parameters);
    next(node.type);
  } else if (ts.isConstructorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    // A constructor and a set accessor have no return type, and their bodies carry no type: their parameters (a parameter property is a field) are all they hold.
    nextAll(node.parameters);
  } else if (ts.isGetAccessorDeclaration(node) || ts.isIndexSignatureDeclaration(node)) {
    nextAll(node.parameters);
    next(node.type);
  } else {
    stop('which is a kind of node that golem does not follow');
  }
}

/** A list of the functions that `writers` holds, each with where it is written. */
function describeWriters(writers: FunctionWriters | undefined): string {
  const entries = [...writers ?? []].map(([writer, at]) => `\`${writer.getName()}\` (${sourceLocation(at)})`);
  return entries.length > 0 ? `the functions ${entries.join(', ')}` : 'no function of this type';
}

/**
 * The function that a tag names. A tag read from source names it by its `typeof` query. A tag that only the checker shows has its type alone.
 * When the index is complete and the program writes one function of that type in a tag, it is that function. Otherwise
 * the walk reads everything the field reaches: it names the function when it reads every tag that can reach the field and finds one function
 * of the type, and it refuses when it finds none or several, or reaches what it cannot read (`reach`): such a tag may name another function.
 */
function functionBinding(
  context: TagAnalysisContext,
  fn: TagFunction,
  kind: FunctionRole,
): ValueBinding {
  if (fn.query) {
    recordWrittenFunction(context, kind, fn.query);
    return valueBindingForSymbol(context, symbolAtExpression(context.checker, fn.query.exprName), kind, fn.owner);
  }
  const index = context.functionIndex();
  const writers = index.writers.get(fn.type);
  const [only, ...others] = writers?.keys() ?? [];
  if (index.complete && only !== undefined && others.length === 0) {
    return valueBindingForSymbol(context, only, kind, fn.owner);
  }
  const writes = index.complete
    ? `This program writes ${describeWriters(writers)} in tags.`
    : `The tags of this program that write \`typeof\` name ${describeWriters(writers)}; a tag written another way can name more.`;
  const registry = context.writtenFunctions;
  if (registry) registry.walk ??= walkSources(context, registry.sources);
  const unreadable = registry?.walk?.unreadable;
  if (unreadable) {
    throw context.diagnostic(fn.owner, '1040', `${kind} function reaches this tag through \`${firstLine(unreadable.node.getText())}\` (${sourceLocation(unreadable.node)}), ${unreadable.reason}, so golem cannot tell which function of this type the tag names. ${writes} Write the tag on the field itself, with \`typeof\` and the function${unreadable.reason === INFERRED ? ', or give that value a type annotation that writes the tag' : ''}.`);
  }
  const written = registry?.[kind].get(fn.type);
  if (written === undefined) {
    throw context.diagnostic(fn.owner, '1040', `${kind} function reaches this tag through a type that golem cannot read back to the \`typeof\` that wrote it, so golem cannot tell which function the tag names. ${writes} Write the tag on the field itself, with \`typeof\` and the function.`);
  }
  if (written === null) {
    throw context.diagnostic(fn.owner, '1040', `${kind} function shares its type with another function in this field, so golem cannot tell which one the tag names. ${writes} Declare each with \`function\`, or give each const its own type annotation.`);
  }
  return valueBindingForSymbol(context, written, kind, fn.owner);
}

/** Reads the sources of one field. */
function walkSources(context: TagAnalysisContext, sources: readonly ts.Node[]): Walk {
  const walk: Walk = { nodes: new Set(), bound: new Set(), unreadable: undefined };
  for (const source of sources) reach(context, walk, source);
  return walk;
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

/** The type node that declares the parameter of a signature, when it writes one. */
function parameterTypeNodes(signature: ts.Signature): readonly ts.TypeNode[] {
  const parameter = signature.parameters[0];
  const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0];
  return declaration && ts.isParameter(declaration) && declaration.type ? [declaration.type] : [];
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

/** The parts of a property's type that decide what it is: an optional property adds `undefined`, which its declaration does not write, and the members of an intersection are the types that it joins. */
function typeParts(type: ts.Type): readonly ts.Type[] {
  const members = (type.isUnion() ? type.types : [type]).filter(member => (member.flags & ts.TypeFlags.Undefined) === 0);
  const [only] = members;
  return members.length === 1 && only?.isIntersection() ? only.types : members;
}

/**
 * The type node that declares the type of a property, or undefined when none does.
 * A property that a mapped type or an intersection builds has no declaration of its own: it copies the declarations
 * of the properties it comes from, and a copy names the type of the original, which a mapped template can change
 * (`{ [K in keyof T]: string }` over a tagged `T`). Such a copy counts only when the types it names make up the property's type.
 * Of two members of an intersection that both declare it, the first whose type fits the merged type names it, as
 * `pets: TCat[]` in `TOwner & { pets: TCat[] }` where TOwner declares `pets: TPet[]`.
 */
export function propertyTypeNode(checker: ts.TypeChecker, property: ts.Symbol, valueType: ts.Type): ts.TypeNode | undefined {
  if (property.valueDeclaration) {
    const declaration = property.valueDeclaration;
    return ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration) ? declaration.type : undefined;
  }
  const nodes = declaredPropertyNodes(checker, property);
  const declared = new Set(nodes.flatMap(node => typeParts(checker.getTypeFromTypeNode(node))));
  const parts = typeParts(valueType);
  if (parts.length !== declared.size || !parts.every(part => declared.has(part))) return undefined;
  return nodes.find(node => checker.isTypeAssignableTo(checker.getTypeFromTypeNode(node), valueType)) ?? nodes[0];
}

/** The declared type of a property, read at its own declaration; `location` stands in for a property that has none. */
export function propertyType(checker: ts.TypeChecker, property: ts.Symbol, location: ts.Node): ts.Type {
  return checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? property.declarations?.[0] ?? location);
}

/** The type of one property of a tag argument's mapping, and the node that declares it. */
function propertyValue(checker: ts.TypeChecker, property: ts.Symbol, owner: ts.Node): { readonly type: ts.Type; readonly node: ts.TypeNode | undefined } {
  const type = propertyType(checker, property, owner);
  return { type, node: propertyTypeNode(checker, property, type) };
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
  if (ts.isStringLiteralType(type)) return type.value;
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
      ? context.checker.getTypeArguments(type)
      : (() => {
        const argument = context.checker.isArrayType(type)
          ? context.checker.getTypeArguments(type)[0]
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
    ? context.checker.getTypeArguments(type)
    : type.isUnion()
      ? type.types
      : context.checker.isArrayType(type)
        ? [context.checker.getTypeArguments(type)[0]]
        : [];
  const nodes = node && ts.isTupleTypeNode(node) ? node.elements : [];
  if (values.length === 0) throw context.diagnostic(owner, '1043', `${label} requires a string tuple or string-literal union.`);
  return values.map((value, index) => literalString(context, value, nodes[index], owner, label));
}

function schemaMap(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  owner: ts.Node,
  label: string,
): Readonly<Record<string, ConstraintSchemaValue>> {
  if (!type || (type.flags & ts.TypeFlags.Object) === 0) {
    throw context.diagnostic(owner, '1043', `${label} requires an object mapping.`);
  }
  const result: Record<string, ConstraintSchemaValue> = Object.create(null);
  for (const property of context.checker.getPropertiesOfType(type)) {
    const value = propertyValue(context.checker, property, owner);
    result[property.getName()] = schemaTypeArgument(context, value.type, owner, label, value.node);
  }
  if (Object.keys(result).length === 0) {
    throw context.diagnostic(owner, '1043', `${label} requires an object mapping with at least one property.`);
  }
  return result;
}

function patternSchemaMap(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  owner: ts.Node,
  label: string,
): Readonly<Record<string, ConstraintSchemaValue>> {
  const result = schemaMap(context, type, owner, label);
  for (const pattern of Object.keys(result)) {
    if (!isUnicodePattern(pattern)) throw context.diagnostic(owner, '1044', `${label} requires valid Unicode regular expression keys.`);
  }
  return result;
}

function dependentRequiredMap(
  context: TagAnalysisContext,
  type: ts.Type | undefined,
  owner: ts.Node,
): Readonly<Record<string, readonly string[]>> {
  if (!type || (type.flags & ts.TypeFlags.Object) === 0) {
    throw context.diagnostic(owner, '1043', 'DependentRequired requires an object mapping.');
  }
  const result: Record<string, readonly string[]> = Object.create(null);
  for (const property of context.checker.getPropertiesOfType(type)) {
    const value = propertyValue(context.checker, property, owner);
    result[property.getName()] = stringList(context, value.type, value.node, owner, 'DependentRequired values');
  }
  if (Object.keys(result).length === 0) {
    throw context.diagnostic(owner, '1043', 'DependentRequired requires an object mapping with at least one property.');
  }
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
      wireNodes: parameterTypeNodes(deserializeSignature),
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
  const patterns = patternSchemaMap(context, argumentType(context.checker, args[0]), at, name);
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
    value: dependentRequiredMap(context, argumentType(context.checker, args[0]), at),
  })],
  ['DependentSchemas', (context, name, args, at) => constraintOnly({
    kind: 'dependentSchemas',
    value: schemaMap(context, argumentType(context.checker, args[0]), at, name),
  })],
  ['OneOf', (context, name, args, at) => constraintOnly({
    kind: 'oneOf',
    schemas: schemaList(context, argumentType(context.checker, args[0]), args[0]?.node, at, name),
  })],
  ['IfThenElse', readIfThenElse],
  ['Discriminator', readDiscriminator],
]);

/**
 * The tag a symbol names with its reader, or undefined when it is no golem tag. The meaning comes from the tag the symbol resolves to; the name
 * written at a use site is the importer's choice.
 */
function golemTag(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): { readonly name: string; readonly read: TagReader } | undefined {
  if (!isGolemTagSymbol(checker, symbol)) return undefined;
  const name = targetSymbol(checker, symbol)?.getName();
  const read = name === undefined ? undefined : TAG_READERS.get(name);
  return name === undefined || read === undefined ? undefined : { name, read };
}

function golemTagName(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): string | undefined {
  return golemTag(checker, symbol)?.name;
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

function instantiatedTag(context: TagAnalysisContext, useSite: AliasUseSite, name: string): TagMetadata {
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
  const [member] = members;
  const tag = parseCheckerTag(atUseSite, member);
  if (tag === undefined) throw new Error(`The ${name} tag that the type of ${useSite.node.getText()} shows is no golem tag.`);
  return tag;
}

function parseTag(
  context: TagAnalysisContext,
  node: ts.TypeReferenceNode,
): TagMetadata | undefined {
  const tag = golemTag(context.checker, context.checker.getSymbolAtLocation(node.typeName));
  if (!tag) return undefined;
  const arguments_ = node.typeArguments ?? [];
  const useSite = context.aliasUseSite;
  if (useSite !== undefined && arguments_.some((argument) => dependsOnAliasParameter(context, argument))) {
    if (tag.name === 'TValidation' || tag.name === 'TSerde') {
      throw context.diagnostic(useSite.node, '1061', `${tag.name} in ${useSite.node.getText()} must name exported functions with typeof, not a type parameter.`);
    }
    return instantiatedTag(context, useSite, tag.name);
  }
  return tag.read(context, tag.name, arguments_.map((argument) => ({ node: argument })), node);
}

function parseCheckerTag(
  context: TagAnalysisContext,
  type: ts.Type,
): TagMetadata | undefined {
  const tag = golemTag(context.checker, type.aliasSymbol);
  if (!tag) return undefined;
  return tag.read(context, tag.name, (type.aliasTypeArguments ?? []).map((argument) => ({ type: argument })), context.sourceFile);
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

/** The first hole of a template literal type that carries a golem tag (`id-${string & MinLength<3>}`), or none. A tag checks a model value, and a hole is a part of one. */
export function taggedTemplateHole(context: TagAnalysisContext, type: ts.TemplateLiteralType): ts.Type | undefined {
  return type.types.find((hole) => hasTagMetadata(metadataFromType(context, hole)));
}

/** Whether a type node is a reference to the `Discriminator` tag, by the tag the symbol resolves to (the importer's name for it does not matter). */
export function isDiscriminatorTag(checker: ts.TypeChecker, node: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(node) && golemTagName(checker, checker.getSymbolAtLocation(node.typeName)) === 'Discriminator';
}

/** The type without its `Discriminator` tag members when one member remains: `A & Discriminator<'k'>` is `A`. Any other type is returned as it is (`untaggedTypeText` prints the rest). */
export function withoutDiscriminator(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  if (!type.isIntersection()) return type;
  const rest = type.types.filter((member) => golemTagName(checker, member.aliasSymbol) !== 'Discriminator');
  return rest.length === 1 && rest.length < type.types.length ? rest[0] : type;
}

/** The text of a type without its `Discriminator` tag members: a variant `Base & { name: string } & Discriminator<'k'>` reads `Base & { name: string; }`. */
export function untaggedTypeText(checker: ts.TypeChecker, type: ts.Type): string {
  const rest = untaggedMembers(checker, type);
  return rest.length === (type.isIntersection() ? type.types.length : 1) ? checker.typeToString(type) : rest.map((member) => checker.typeToString(member)).join(' & ');
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
    let dataParts = 0;
    let metadata = EMPTY;
    for (const part of node.types) {
      const tag = ts.isTypeReferenceNode(part) ? parseTag(context, part) : undefined;
      if (tag) {
        metadata = mergeMetadata(context, part, metadata, tag);
        continue;
      }
      const nested = readTags(context, part, seenAliases);
      if (nested.baseNode) dataParts += 1;
      baseNode ??= nested.baseNode;
      metadata = mergeMetadata(context, part, metadata, nested.metadata);
    }
    // Several data parts (`{ a: string } & { b: number }`, a brand beside the type) are no single untagged part: the whole node is the
    // base, and the type analysis drops the tag and brand members from its type.
    return baseNode ? { baseNode: dataParts > 1 ? node : baseNode, metadata } : emptyBase(node);
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
      if (hasTagMetadata(nested.metadata)) return nested;
    }
  }
  return emptyBase(node);
}

export function analyzeNode(
  context: TagAnalysisContext,
  type: ts.Type,
  node: ts.TypeNode | undefined,
  /** Nodes beside `node` that write the functions of the field's tags: the declarations that a mapped type copied, the wire parameter of a serde. */
  tagSources: readonly ts.Node[],
): TagReadResult {
  const sources = node ? [node, ...tagSources] : tagSources;
  const writtenFunctions = newWrittenFunctions(sources);
  const nodeContext: TagAnalysisContext = { ...context, writtenFunctions };
  const result = node ? readTags(nodeContext, node) : { baseNode: undefined, metadata: EMPTY };
  const metadata = mergeMetadata(nodeContext, node ?? context.sourceFile, result.metadata, metadataFromType(nodeContext, type));
  // Tags that only the checker type carries mean the node is not where this type comes from (the declaration a
  // mapped property inherits is not the type its template computes), so the node is no untagged base.
  return { baseNode: hasTagMetadata(result.metadata) ? result.baseNode : undefined, metadata };
}
