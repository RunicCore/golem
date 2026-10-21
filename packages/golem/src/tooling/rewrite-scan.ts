import fs from 'node:fs';
import path from 'node:path';
import * as ts from './typescript-ns.js';
import { GolemDiagnosticSeverity, canonicalPath, isRecord } from './generator-api.js';
import type { GeneratorSession, GolemDiagnostic } from './generator-api.js';
import { operationCodecRegistryPath } from './generated-paths.js';
import { REWRITE_IMPORT_PREFIX } from './rewrite.js';
import type { FileRewrite, RewriteEdit, RewriteImport } from './rewrite.js';
import { readModelManifest } from './model-manifest.js';
import { createProjectProgram, canonicalFilename, companionFilename, isGeneratedCompanion, modelBoundary, retainedProgramSession, type ModelBoundary } from './type-analysis/project.js';
import { packageSpecifier } from './type-analysis/package-specifier.js';
import { advertisedModelManifests } from './type-analysis/provenance.js';
import { fieldProvenance } from './type-analysis/projections.js';
import { declaredModelAlias, foreignModelReason, modelDeclarationKind, resolveSymbol } from './type-analysis/symbols.js';

interface ScanInput {
  /** Absolute project root; file paths in results are relative to it. */
  readonly root: string;
  /** The directory of the golem.yaml: where the search for a shared model file's package folder stops. */
  readonly directory: string;
  /** `models.root` of the project's models job. */
  readonly modelsRoot: string;
  /** The `suffixes` of the models job: a model is declared in a file whose name ends in one of them. Defaults to the golem default. */
  readonly suffixes?: readonly string[] | undefined;
  /** `models.output` of the project's models job: the generated file of a shared model is there. Without it every companion is beside its model file. */
  readonly output?: string | undefined;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** The project's `.golem/codec-keys.json`, which the program does not hold; a missing file holds no keys. */
  readonly codecKeysFile: string;
  /** The project has NestJS controllers: `@Body()` and `@Query()` parameters and method returns of a model get codec decorators. */
  readonly nest: boolean;
}

/** A `@Body()` or `@Query()` parameter that the scan stamps with `nestModelCodec(id)`. */
interface NestCodecSite {
  /** Root-relative file. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly decorator: string;
  /** The model type as the parameter spells it, array wrappers removed. */
  readonly label: string;
  readonly id: string;
}

const SERDE_MODULE = '@exprtlabs/golem/serde';
const NEST_MODULE = '@exprtlabs/golem/nest';
const NEST_PARAMETER_DECORATORS: readonly string[] = ['Body', 'Query'];
const NEST_CODEC_DECORATOR = 'nestModelCodec';
const NEST_RETURN_DECORATOR = 'nestModelReturn';
/** Type names a nest parameter or return never carries a model codec for. */
const NEST_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'void', 'undefined', 'null', 'never', 'any', 'unknown', 'object', 'string', 'number', 'boolean', 'bigint', 'symbol',
  'Date', 'Buffer', 'Blob', 'Promise', 'Array', 'Record', 'Map', 'Set',
]);
const BASE_MODEL_SUFFIX = 'BaseModel';

const CODE_TYPE_ARGUMENT = 'RUNM1066';
const CODE_NO_CODEC = 'RUNM1067';
const CODE_RESERVED_PREFIX = 'RUNM1068';
const CODE_IMPORT_CLASH = 'RUNM1069';
const CODE_NEST_NO_CODEC = 'RUNM1071';
const CODE_NEST_REGISTRY = 'RUNM1072';
/** A model that golem does not generate for this project: its file name has no model suffix. */
const CODE_FOREIGN_MODEL = 'RUNM1074';

/** The serde functions a type argument turns into a codec call, and the runtime method each becomes. */
const SERDE_METHODS: ReadonlyMap<string, string> = new Map([
  ['stringify', 'stringify'],
  ['parse', 'parse'],
  ['validate', 'validate'],
  ['assertValue', 'assert'],
  ['toWireFormat', 'toWireFormat'],
  ['fromWireFormat', 'fromWireFormat'],
]);

/** Any `*.generated.<ext>` module, such as `x.entity.generated.ts` or `models.generated.ts`, and its emitted JavaScript and declarations. */
const GENERATED_MODEL_MODULE = /\.generated\.(?:d\.)?[cm]?[jt]s$/;

function portable(root: string, filename: string): string {
  return path.relative(root, filename).split(path.sep).join('/');
}

// Codec keys

/** The `<source>#<name>` keys of a project's `.golem/codec-keys.json`, absent when `golem generate` has not written it. */
function readCodecKeysFile(filename: string): Readonly<Record<string, string>> {
  let text: string;
  try {
    text = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const keys = isRecord(parsed) && parsed.version === 1 ? parsed.keys : undefined;
  if (!isRecord(keys) || !Object.values(keys).every((id) => typeof id === 'string')) {
    throw new Error(`${filename} is not a golem codec key file; run golem generate.`);
  }
  return keys as Readonly<Record<string, string>>;
}

/**
 * The codec id of every declaration a rewrite can name, from two sources: the project's `.golem/codec-keys.json` and the
 * `codecId` of the model manifests that the program's files advertise.
 */
class CodecKeys {
  /** Each declaration's ids, each with the files that give it; more than one id makes the declaration ambiguous. */
  private readonly byDeclaration = new Map<string, Map<string, Set<string>>>();
  /** The generated module that registers each codec id, where a manifest says which. */
  private readonly manifestModules = new Map<string, string>();
  /** The key file's declarations of each codec id, in file order: the model file of one is where the generated module that registers the id is looked up. */
  private readonly keyDeclarations = new Map<string, string[]>();
  /** The key file's entries by model name: a class that extends `<Name>BaseModel` is a class of the model with that name whose companion declares the base. */
  private readonly keysByName = new Map<string, { readonly declaration: string; readonly id: string; readonly table: string }[]>();
  /** The companion of each model file of a key, found on first use: a scan asks for few of them. */
  private readonly companions = new Map<string, string | undefined>();
  /** The generated companions of the program by real path, built when a companion is not found under its real path (a project reached through a folder link). */
  private companionsByRealPath: Map<string, string> | undefined;

  /** The real path of the tsconfig's directory: a key is a file's real path from it, as `golem generate` writes it. */
  private readonly base: string;
  private readonly keysByFile = new Map<string, string>();

  constructor(private readonly program: ts.Program, private readonly checker: ts.TypeChecker, private readonly root: string, codecKeysFile: string, private readonly boundary: ModelBoundary) {
    this.base = canonicalPath(root);
    const table = portable(root, codecKeysFile);
    for (const [declaration, id] of Object.entries(readCodecKeysFile(codecKeysFile))) {
      if (declaration.lastIndexOf('#') > 0 && id !== '') {
        const key = declaration.replace(/\\/g, '/');
        this.add(key, id, table);
        this.keyDeclarations.set(id, [...(this.keyDeclarations.get(id) ?? []), key]);
        const name = key.slice(key.lastIndexOf('#') + 1);
        this.keysByName.set(name, [...(this.keysByName.get(name) ?? []), { declaration: key, id, table }]);
      }
    }
    this.addManifests();
  }

  /** The models of the manifests that the program's files advertise, resolved to the declarations they export in this program. */
  private addManifests(): void {
    const exportsOf = new Map<ts.SourceFile, ReadonlyMap<string, ts.Symbol>>();
    const declarationsOf = (manifestFile: string, module: string, exportName: string): ts.Symbol | undefined => {
      const file = this.program.getSourceFile(canonicalFilename(path.resolve(path.dirname(manifestFile), module)));
      if (!file) return undefined;
      let exported = exportsOf.get(file);
      if (!exported) {
        const moduleSymbol = this.checker.getSymbolAtLocation(file);
        exported = new Map((moduleSymbol ? this.checker.getExportsOfModule(moduleSymbol) : []).map((symbol) => [symbol.name, symbol]));
        exportsOf.set(file, exported);
      }
      return resolveSymbol(this.checker, exported.get(exportName));
    };
    for (const manifestFile of advertisedModelManifests(this.program)) {
      const table = portable(this.root, manifestFile);
      for (const model of readModelManifest(manifestFile).models) {
        for (const { module, export: exportName } of [model.generated, model.type, ...(model.type.aliases ?? [])]) {
          const symbol = declarationsOf(manifestFile, module, exportName);
          this.addManifestModule(model.codecId, this.program.getSourceFile(canonicalFilename(path.resolve(path.dirname(manifestFile), model.generated.module)))?.fileName);
          for (const declaration of symbol?.declarations ?? []) {
            this.add(`${this.keyOf(declaration.getSourceFile().fileName)}#${symbol!.name}`, model.codecId, table);
          }
        }
      }
    }
  }

  /** The file's real path from the tsconfig's directory, with forward slashes: a file reached through a folder link has one key. */
  private keyOf(filename: string): string {
    let key = this.keysByFile.get(filename);
    if (key === undefined) this.keysByFile.set(filename, key = portable(this.base, canonicalPath(filename)));
    return key;
  }

  /**
   * The program's own name for the generated companion of the model file a key names, when the program holds it: beside an own file, in
   * `models.output` for a shared one. A key is a real path, and a program reached through a folder link spells its files by the link.
   */
  private companionOf(declaration: string): string | undefined {
    const modelFile = path.resolve(this.base, declaration.slice(0, declaration.lastIndexOf('#')));
    if (!this.companions.has(modelFile)) {
      let companion: string | undefined;
      if (/\.[cm]?ts$/.test(modelFile)) {
        const real = companionFilename(this.boundary, modelFile);
        companion = this.program.getSourceFile(canonicalFilename(real))?.fileName ?? this.programCompanions().get(canonicalPath(real));
      }
      this.companions.set(modelFile, companion);
    }
    return this.companions.get(modelFile);
  }

  private programCompanions(): ReadonlyMap<string, string> {
    return this.companionsByRealPath ??= new Map(this.program.getSourceFiles()
      .filter((file) => isGeneratedCompanion(file.fileName))
      .map((file) => [canonicalPath(file.fileName), file.fileName] as const));
  }

  private addManifestModule(id: string, module: string | undefined): void {
    if (module !== undefined && !this.manifestModules.has(id)) this.manifestModules.set(id, module);
  }

  /** The absolute file of the generated module that registers the codec, or undefined when no key file or manifest names it. A key file wins over a manifest. */
  moduleOf(id: string): string | undefined {
    for (const declaration of this.keyDeclarations.get(id) ?? []) {
      const companion = this.companionOf(declaration);
      if (companion !== undefined) return companion;
    }
    return this.manifestModules.get(id);
  }

  private add(declaration: string, id: string, table: string): void {
    const ids = this.byDeclaration.get(declaration) ?? new Map<string, Set<string>>();
    this.byDeclaration.set(declaration, ids);
    ids.set(id, (ids.get(id) ?? new Set()).add(table));
  }

  /**
   * The codec id of the named declaration in the file: the id that the key file and the manifests give it.
   * The key files and manifests that give a found id are added to `dependencies`.
   */
  idFor(filename: string, name: string, dependencies: Set<string>): string {
    if (name === '') return '';
    const ids = this.byDeclaration.get(`${this.keyOf(filename)}#${name}`);
    // Two sources that give one declaration different ids give it none: the call reports it instead of choosing.
    if (ids?.size !== 1) return '';
    const [[id, tables]] = [...ids];
    for (const table of tables) dependencies.add(table);
    return id;
  }

  /** The id of the model whose generated base class `base` is, from the key file of this project. */
  idForBase(base: GeneratedBase, dependencies: Set<string>): string {
    // The last key whose companion declares the base wins.
    const file = canonicalFilename(base.file);
    const found = (this.keysByName.get(base.name.slice(0, -BASE_MODEL_SUFFIX.length)) ?? []).filter(({ declaration }) => {
      const companion = this.companionOf(declaration);
      return companion !== undefined && canonicalFilename(companion) === file;
    }).at(-1);
    if (found !== undefined) dependencies.add(found.table);
    return found?.id ?? '';
  }

  idForSymbol(symbol: ts.Symbol, dependencies: Set<string>): string {
    for (const declaration of symbol.declarations ?? []) {
      const id = this.idFor(declaration.getSourceFile().fileName, symbol.name, dependencies);
      if (id !== '') return id;
    }
    return '';
  }
}

// Symbols and declarations

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const direct = checker.getSymbolAtLocation(node);
  if (direct) return direct;
  if (ts.isQualifiedName(node)) return checker.getSymbolAtLocation(node.right);
  if (ts.isPropertyAccessExpression(node)) return checker.getSymbolAtLocation(node.name);
  return undefined;
}

function resolvedSymbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  return resolveSymbol(checker, symbolAt(checker, node));
}

function unwrapParentheses(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function declaredInGolem(symbol: ts.Symbol, basenames: readonly string[]): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    const filename = declaration.getSourceFile().fileName.replace(/\\/g, '/');
    return basenames.includes(path.posix.basename(filename))
      && (filename.includes('@exprtlabs/golem/') || filename.includes('/packages/golem/'));
  });
}

/** The runtime method a call to this callee rewrites to, when the callee is golem's own serde (or validation) function. */
function serdeMethod(checker: ts.TypeChecker, callee: ts.Expression): { readonly name: string; readonly method: string } | undefined {
  const symbol = resolvedSymbolAt(checker, unwrapParentheses(callee));
  const method = symbol && SERDE_METHODS.get(symbol.name);
  if (!symbol || method === undefined) return undefined;
  const owners = symbol.name === 'validate' ? ['validation.ts', 'validation.d.ts'] : ['serde.ts', 'serde.d.ts'];
  return declaredInGolem(symbol, owners) ? { name: symbol.name, method } : undefined;
}

/** The name a serde type argument stands for: a type reference without type arguments or `typeof X`. */
function serdeTypeName(typeNode: ts.TypeNode): ts.EntityName | undefined {
  let node = typeNode;
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  if (ts.isTypeReferenceNode(node)) return node.typeArguments?.length ? undefined : node.typeName;
  if (ts.isTypeQueryNode(node)) return node.typeArguments?.length ? undefined : node.exprName;
  return undefined;
}

/** The generated base class a model class extends: its name, and the generated module that declares it. */
interface GeneratedBase {
  readonly file: string;
  readonly name: string;
}

/** The classes `declaration` extends by name; `Mixin(YBaseModel)` and any other base expression have none. */
function extendedClasses(checker: ts.TypeChecker, declaration: ts.ClassDeclaration): ts.Symbol[] {
  return (declaration.heritageClauses ?? [])
    .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((clause) => clause.types)
    .flatMap((base) => {
      const expression = unwrapParentheses(base.expression);
      const symbol = ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) ? resolvedSymbolAt(checker, expression) : undefined;
      return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0 ? [symbol] : [];
    });
}

/** The generated model module that declares `YBaseModel` in `class X extends YBaseModel`. */
function generatedBase(checker: ts.TypeChecker, declaration: ts.ClassDeclaration): GeneratedBase | undefined {
  for (const symbol of extendedClasses(checker, declaration)) {
    if (!symbol.name.endsWith(BASE_MODEL_SUFFIX)) continue;
    const generated = (symbol.declarations ?? []).find((candidate) => ts.isClassDeclaration(candidate)
      && GENERATED_MODEL_MODULE.test(candidate.getSourceFile().fileName));
    if (generated) return { file: generated.getSourceFile().fileName, name: symbol.name };
  }
  return undefined;
}

/** As `generatedBase`, also through the classes between: `class C extends A` where `A extends YBaseModel`. */
function generatedBaseThrough(checker: ts.TypeChecker, declaration: ts.ClassDeclaration, seen = new Set<ts.ClassDeclaration>()): GeneratedBase | undefined {
  if (seen.has(declaration)) return undefined;
  seen.add(declaration);
  const direct = generatedBase(checker, declaration);
  if (direct !== undefined) return direct;
  for (const symbol of extendedClasses(checker, declaration)) {
    for (const candidate of symbol.declarations ?? []) {
      const found = ts.isClassDeclaration(candidate) ? generatedBaseThrough(checker, candidate, seen) : undefined;
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The id of the model whose generated base `declaration` extends, directly or through other classes, wherever the class is written: a shared model's class is the app's own. A default export has none. */
function idOfBaseOf(checker: ts.TypeChecker, keys: CodecKeys, declaration: ts.ClassDeclaration, dependencies: Set<string>): string {
  const isDefault = declaration.name !== undefined && checker.getSymbolAtLocation(declaration.name)?.name === 'default';
  const base = isDefault ? undefined : generatedBaseThrough(checker, declaration);
  return base === undefined ? '' : keys.idForBase(base, dependencies);
}

/** The codec id of a symbol: its own key, or, for a class, the id of the model whose generated base it extends. */
function codecIdOf(checker: ts.TypeChecker, keys: CodecKeys, symbol: ts.Symbol, dependencies: Set<string>): string {
  const own = keys.idForSymbol(symbol, dependencies);
  if (own !== '') return own;
  for (const declaration of symbol.declarations ?? []) {
    const id = ts.isClassDeclaration(declaration) ? idOfBaseOf(checker, keys, declaration, dependencies) : '';
    if (id !== '') return id;
  }
  return '';
}

/** The model a class registers for: its id from its own key or from the generated base it extends directly. A subclass of such a class registers for nothing. */
function registeredModelOf(
  input: { readonly checker: ts.TypeChecker; readonly keys: CodecKeys },
  file: ts.SourceFile,
  node: ts.ClassDeclaration & { readonly name: ts.Identifier },
  dependencies: Set<string>,
): { readonly id: string; readonly base: GeneratedBase } | undefined {
  const base = generatedBase(input.checker, node);
  const id = base === undefined ? '' : input.keys.idFor(file.fileName, node.name.text, dependencies) || idOfBaseOf(input.checker, input.keys, node, dependencies);
  return base !== undefined && id !== '' ? { id, base } : undefined;
}

/** How many classes register for each model across `files`: with several, none is the default and each registers under `<id>#<class>`. */
function countModelClasses(input: { readonly checker: ts.TypeChecker; readonly keys: CodecKeys }, files: readonly ts.SourceFile[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const visit = (file: ts.SourceFile, node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const found = registeredModelOf(input, file, node as ts.ClassDeclaration & { readonly name: ts.Identifier }, new Set());
      if (found !== undefined) counts.set(found.id, (counts.get(found.id) ?? 0) + 1);
    }
    ts.forEachChild(node, (child) => { visit(file, child); return undefined; });
  };
  for (const file of files) visit(file, file);
  return counts;
}

function insertion(at: number, text: string): RewriteEdit {
  return { start: at, end: at, expect: '', text };
}

function locate(root: string, file: ts.SourceFile, node: ts.Node, code: string, message: string): GolemDiagnostic {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { code, severity: GolemDiagnosticSeverity.Error, message, file: portable(root, file.fileName), line: line + 1, column: character + 1 };
}

// NestJS codec metadata

/** Whether the name is `name` or a qualified spelling of it, such as `globalThis.Array`. */
function isNamed(typeName: ts.EntityName, ...names: readonly string[]): boolean {
  return names.includes(ts.isIdentifier(typeName) ? typeName.text : typeName.right.text);
}

/**
 * The model of a parameter or return type and whether it is an array of it, through parentheses, `readonly`, and one
 * `T[]`, `Array<T>` or `ReadonlyArray<T>`; `Promise<T>` too for a return. Nested arrays have no model. A return union has
 * none either; a parameter union stays one type, which binds to no codec.
 */
function nestModelType(typeNode: ts.TypeNode, forReturn: boolean): { readonly model: ts.TypeNode; readonly array: boolean } | undefined {
  let node = typeNode;
  let array = false;
  const wrapArray = (element: ts.TypeNode): boolean => {
    if (array) return false;
    array = true;
    node = element;
    return true;
  };
  for (;;) {
    if (ts.isParenthesizedTypeNode(node)) node = node.type;
    else if (ts.isArrayTypeNode(node)) { if (!wrapArray(node.elementType)) return undefined; }
    else if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) node = node.type;
    else if (ts.isTypeOperatorNode(node) || ts.isUnionTypeNode(node)) return forReturn ? undefined : { model: node, array };
    else if (forReturn && ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1 && isNamed(node.typeName, 'Promise')) node = node.typeArguments[0];
    else if (ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1 && isNamed(node.typeName, 'Array', 'ReadonlyArray')) { if (!wrapArray(node.typeArguments[0])) return undefined; }
    else return { model: node, array };
  }
}

/** The name a decorator is called by, as `@Name()`, `@Name` or `@namespace.Name()`; the receiver is not checked. */
function decoratorName(decorator: ts.Decorator): string | undefined {
  const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function decoratorNames(node: ts.Node): readonly string[] {
  return (ts.getDecorators(node) ?? []).flatMap((decorator) => decoratorName(decorator) ?? []);
}

/** Whether the node carries the decorator, written plainly or as the aliased import an earlier rewrite added. */
function hasDecorator(names: readonly string[], name: string): boolean {
  return names.includes(name) || names.includes(`${REWRITE_IMPORT_PREFIX}${name}`);
}

/**
 * Whether the symbol is a golem model by its declaration, not by a key table that a new model may not be in yet: an alias of
 * `IModel<…>` or `IObject<…>`, through other aliases, or a class that extends a `*BaseModel` of a generated module.
 */
function isGolemModel(checker: ts.TypeChecker, symbol: ts.Symbol, seen = new Set<ts.Symbol>()): boolean {
  if (seen.has(symbol)) return false;
  seen.add(symbol);
  return (symbol.declarations ?? []).some((declaration) => {
    if (ts.isClassDeclaration(declaration)) return generatedBaseThrough(checker, declaration) !== undefined;
    if (!ts.isTypeAliasDeclaration(declaration)) return false;
    if (modelDeclarationKind(checker, declaration.type) !== undefined) return true;
    const target = ts.isTypeReferenceNode(declaration.type) ? resolvedSymbolAt(checker, declaration.type.typeName) : undefined;
    return target !== undefined && isGolemModel(checker, target, seen);
  });
}

interface NestBinding {
  readonly id: string;
  readonly primitive: boolean;
  /** The type is a golem model, so one that binds to no id is an error rather than a plain class. */
  readonly golemModel: boolean;
  /** The model type as written, array wrappers removed. */
  readonly label: string;
  /** The type is an array of the model. */
  readonly array: boolean;
  /** The type name of the model, when it has one. */
  readonly name?: ts.EntityName;
  /** The model is a class that is the default export of its file, which golem cannot key. */
  readonly defaultExport?: boolean;
}

function nestBinding(
  input: { readonly checker: ts.TypeChecker; readonly keys: CodecKeys; readonly file: ts.SourceFile; readonly dependencies: Set<string> },
  typeNode: ts.TypeNode,
): NestBinding {
  const { checker, keys, file, dependencies } = input;
  const walked = nestModelType(typeNode, false);
  const model = walked?.model;
  const unbound = { id: '', primitive: false, golemModel: false, label: (model ?? typeNode).getText(file), array: walked?.array ?? false };
  if (!model) return unbound;
  const { label } = unbound;
  if (NEST_PRIMITIVE_TYPES.has(label.slice(label.lastIndexOf('.') + 1))) return { ...unbound, primitive: true };
  const name = serdeTypeName(model);
  const symbol = name && resolvedSymbolAt(checker, name);
  if (!symbol) return { ...unbound, golemModel: modelDeclarationKind(checker, model) !== undefined };
  return { ...unbound, id: codecIdOf(checker, keys, symbol, dependencies), golemModel: isGolemModel(checker, symbol), name, defaultExport: symbol.name === 'default' };
}

// One file

interface FileScan {
  readonly edits: RewriteEdit[];
  /** Imported name to its module; one module per name, because the applier imports each name once. */
  readonly imports: Map<string, string>;
  /** Modules the file loads for their side effects: the generated modules that register the codecs its edits name. */
  readonly loads: Set<string>;
  readonly diagnostics: GolemDiagnostic[];
  readonly nestSites: NestCodecSite[];
  /** Root-relative key tables and generated model modules the edits were resolved from. */
  readonly dependencies: Set<string>;
}

function importOf(
  scan: FileScan,
  root: string,
  file: ts.SourceFile,
  node: ts.Node,
  name: string,
  from: string,
): void {
  const existing = scan.imports.get(name);
  if (existing !== undefined && existing !== from) {
    scan.diagnostics.push(locate(root, file, node, CODE_IMPORT_CLASH,
      `"${name}" is imported from both ${existing} and ${from}; golem needs one module for each name it imports for a rewrite.`));
    return;
  }
  scan.imports.set(name, from);
}

/** The module text of the import that binds the leftmost name of a type, as the file spells it. */
function importSpecifierOf(checker: ts.TypeChecker, name: ts.EntityName): string | undefined {
  for (const declaration of checker.getSymbolAtLocation(entityNameSegments(name)[0]!)?.declarations ?? []) {
    let node: ts.Node = declaration;
    while (!ts.isImportDeclaration(node) && !ts.isSourceFile(node)) node = node.parent;
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) return node.moduleSpecifier.text;
  }
  return undefined;
}

/** The spelling of a project source's module from `from`: relative, with the extension of its emitted file, as Node, the bundlers and tsc all resolve it. */
function relativeSpecifier(from: string, target: string): string {
  const emitted = target.replace(/\.ts$/, '.js').replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs');
  const relative = path.relative(path.dirname(from), emitted).split(path.sep).join('/');
  return relative.startsWith('../') ? relative : `./${relative}`;
}

/**
 * A rewrite that names a codec id also loads the module that registers it: TypeScript drops an import that the file uses only as a
 * type, so without this the codec never registers. A project companion is loaded by its own path, and an installed SDK's generated
 * module by the package name and the subpath that reaches it. The module the file imports the type from is only the last resort: it
 * may re-export the type and compile to an empty import.
 */
function loadCodecModule(
  scan: FileScan,
  input: { readonly root: string; readonly checker: ts.TypeChecker; readonly keys: CodecKeys; readonly file: ts.SourceFile },
  id: string,
  typeName: ts.EntityName | undefined,
): void {
  const { root, checker, keys, file } = input;
  const module = keys.moduleOf(id);
  if (module === file.fileName) return;
  const project = module !== undefined && !module.split(/[\\/]/).includes('node_modules') && !/\.d\.[cm]?ts$/.test(module);
  const installed = module === undefined || project ? undefined : packageSpecifier(module, file.fileName, root);
  const specifier = project ? relativeSpecifier(file.fileName, module)
    : installed?.kind === 'package' ? installed.specifier
      : typeName && importSpecifierOf(checker, typeName);
  if (specifier) scan.loads.add(specifier);
}

/** The module and exported name of a type-only import that binds the name; undefined for any other binding. */
function typeOnlyImportOf(declaration: ts.Node): { readonly from: string; readonly exported: string } | undefined {
  const clauseTypeOnly = (clause: ts.ImportClause): boolean =>
    clause.isTypeOnly === true || clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
  if (ts.isImportSpecifier(declaration)) {
    const clause = declaration.parent.parent;
    const statement = clause.parent;
    if (!ts.isImportClause(clause) || !ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return undefined;
    if (!declaration.isTypeOnly && !clauseTypeOnly(clause)) return undefined;
    return { from: statement.moduleSpecifier.text, exported: (declaration.propertyName ?? declaration.name).text };
  }
  if (ts.isImportClause(declaration) && declaration.name && clauseTypeOnly(declaration)) {
    const statement = declaration.parent;
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return undefined;
    return { from: statement.moduleSpecifier.text, exported: 'default' };
  }
  return undefined;
}

/**
 * The text that names the class a `parse<T>` / `fromWireFormat<T>` call constructs: T as the file spells it, or, when
 * T is a type-only import, an aliased value import the applier adds. Undefined when T is not a class.
 */
function constructTarget(
  scan: FileScan,
  input: { readonly root: string; readonly checker: ts.TypeChecker; readonly file: ts.SourceFile },
  name: ts.EntityName,
): string | undefined {
  const symbol = resolvedSymbolAt(input.checker, name);
  if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0) return undefined;
  const local = name.getText(input.file);
  if (/[\r\n]/.test(local)) return undefined;
  const segments = entityNameSegments(name);
  const root = segments[0]!;
  const declarations = input.checker.getSymbolAtLocation(root)?.declarations ?? [];
  const typeOnly = declarations.map(typeOnlyImportOf).find((found) => found !== undefined);
  if (typeOnly) {
    // `Payment`, or `m.Payment` where `import type { m }` binds a namespace: the import is aliased and keeps the rest of the path.
    importOf(scan, input.root, input.file, name, typeOnly.exported, typeOnly.from);
    return [`${REWRITE_IMPORT_PREFIX}${typeOnly.exported}`, ...segments.slice(1).map((segment) => segment.text)].join('.');
  }
  const module = declarations.map(typeOnlyNamespaceImportOf).find((found) => found !== undefined);
  if (module && segments.length > 1) {
    // `m.Payment` where `import type * as m` binds the module: the member is imported on its own, as `Payment` is above.
    const member = segments[1]!.text;
    importOf(scan, input.root, input.file, name, member, module);
    return [`${REWRITE_IMPORT_PREFIX}${member}`, ...segments.slice(2).map((segment) => segment.text)].join('.');
  }
  return local;
}

/** The identifiers of a name, left to right. */
function entityNameSegments(name: ts.EntityName): ts.Identifier[] {
  return ts.isIdentifier(name) ? [name] : [...entityNameSegments(name.left), name.right];
}

/** The module of a type-only `import type * as ns from '…'` that binds the namespace; undefined for any other binding. */
function typeOnlyNamespaceImportOf(declaration: ts.Node): string | undefined {
  const clause = declaration.parent;
  if (!ts.isNamespaceImport(declaration) || !ts.isImportClause(clause) || !ts.isImportDeclaration(clause.parent)) return undefined;
  const { moduleSpecifier } = clause.parent;
  const typeOnly = clause.isTypeOnly === true || clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
  return typeOnly && ts.isStringLiteralLike(moduleSpecifier) ? moduleSpecifier.text : undefined;
}

/** Whether a property name is `construct`, written plain, quoted or as a computed string. */
function namesConstruct(name: ts.PropertyName): boolean {
  if (ts.isComputedPropertyName(name)) return ts.isStringLiteralLike(name.expression) && name.expression.text === 'construct';
  return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === 'construct';
}

function constructOptionEdits(file: ts.SourceFile, call: ts.CallExpression, target: string): RewriteEdit[] {
  const [first, second] = call.arguments;
  if (!first) return [];
  if (!second) return [insertion(first.end, `, { construct: ${target} }`)];
  let options: ts.Expression = second;
  while (ts.isParenthesizedExpression(options)) options = options.expression;
  const given = ts.isObjectLiteralExpression(options)
    && options.properties.some((property) => !ts.isSpreadAssignment(property) && namesConstruct(property.name));
  if (given) return [];
  const start = second.getStart(file);
  // The options spread last, so a `construct` that the user's options hold, in a variable or a spread, wins over the default class.
  // Boundary insertions keep serde calls nested in the options independent edits.
  return [insertion(start, `{ construct: ${target}, ...`), insertion(second.end, ' }')];
}

function scanFile(
  input: { readonly root: string; readonly checker: ts.TypeChecker; readonly keys: CodecKeys; readonly nest: boolean; readonly boundary: ModelBoundary; readonly modelClasses: () => ReadonlyMap<string, number> },
  file: ts.SourceFile,
): FileScan {
  const { root, checker, keys, nest, boundary } = input;
  const text = file.text;
  const scan: FileScan = { edits: [], imports: new Map(), loads: new Set(), diagnostics: [], nestSites: [], dependencies: new Set() };
  const classes: { readonly name: string; readonly id: string; readonly end: number }[] = [];
  let reserved: ts.Identifier | undefined;

  const visitCall = (call: ts.CallExpression): void => {
    if (call.questionDotToken || !call.typeArguments?.length) return;
    const serde = serdeMethod(checker, call.expression);
    if (!serde) return;
    const { method } = serde;
    const typeName = call.typeArguments.length === 1 ? serdeTypeName(call.typeArguments[0]) : undefined;
    if (!typeName) {
      scan.diagnostics.push(locate(root, file, call, CODE_TYPE_ARGUMENT, `${method} type argument must be a single type name or typeof expression`));
      return;
    }
    const symbol = resolvedSymbolAt(checker, typeName);
    const id = symbol ? codecIdOf(checker, keys, symbol, scan.dependencies) : '';
    if (id === '') {
      const model = fieldProvenance(checker, call.typeArguments[0], []).anonymous;
      const alias = model && declaredModelAlias(model);
      const foreign = alias ? foreignModelReason(alias, boundary) : undefined;
      scan.diagnostics.push(foreign !== undefined
        ? locate(root, file, call, CODE_FOREIGN_MODEL, foreign)
        : locate(root, file, call, CODE_NO_CODEC, `${method}<${call.typeArguments[0].getText(file)}> has no unique codec id`));
      return;
    }
    const start = call.expression.getStart(file);
    // The argument list starts right after the `(` that opens it, whatever trivia sits between the type arguments and the `(`.
    const open = call.arguments.pos - 1;
    scan.edits.push({
      start,
      end: open + 1,
      expect: text.slice(start, open + 1),
      text: `${REWRITE_IMPORT_PREFIX}requireObjectCodec(${JSON.stringify(id)}).${method}(`,
    });
    importOf(scan, root, file, call, 'requireObjectCodec', SERDE_MODULE);
    loadCodecModule(scan, { root, checker, keys, file }, id, typeName);
    if (method === 'parse' || method === 'fromWireFormat') {
      const target = constructTarget(scan, { root, checker, file }, typeName);
      if (target !== undefined) scan.edits.push(...constructOptionEdits(file, call, target));
    }
  };

  /** A `@Body()` or `@Query()` parameter of a model gets `@nestModelCodec(id)` before its name. */
  const visitParameter = (parameter: ts.ParameterDeclaration): void => {
    const names = decoratorNames(parameter);
    const decorator = names.find((name) => NEST_PARAMETER_DECORATORS.includes(name));
    if (!parameter.type || decorator === undefined || hasDecorator(names, NEST_CODEC_DECORATOR)) return;
    const { id, primitive, golemModel, label, array, name, defaultExport } = nestBinding({ checker, keys, file, dependencies: scan.dependencies }, parameter.type);
    if (primitive) return;
    if (id === '') {
      if (golemModel) scan.diagnostics.push(locate(root, file, parameter.type, CODE_NEST_NO_CODEC, defaultExport
        ? `@${decorator}() type ${label} is the default export of its file, which has no codec id; golem generate cannot add one. Export the class by name (export class ${label}) and import it by name.`
        : `@${decorator}() type ${label} has no unique codec id; run golem generate`));
      return;
    }
    scan.edits.push(insertion(parameter.name.getStart(file), `@${REWRITE_IMPORT_PREFIX}${NEST_CODEC_DECORATOR}(${JSON.stringify(id)}${array ? ', true' : ''}) `));
    importOf(scan, root, file, parameter, NEST_CODEC_DECORATOR, NEST_MODULE);
    loadCodecModule(scan, { root, checker, keys, file }, id, name);
    const { line, character } = file.getLineAndCharacterOfPosition(parameter.type.getStart(file));
    scan.nestSites.push({ file: portable(root, file.fileName), line: line + 1, column: character + 1, decorator, label, id });
  };

  /** A class method that returns a model gets `@nestModelReturn(id[, true])` before its other decorators. */
  const visitMethod = (method: ts.MethodDeclaration): void => {
    // A decorator is a syntax error on an object literal method, an abstract method and an overload signature.
    if (!method.type || !method.body || !ts.isClassLike(method.parent)) return;
    const returned = nestModelType(method.type, true);
    if (!returned || hasDecorator(decoratorNames(method), NEST_RETURN_DECORATOR)) return;
    const { id, primitive, name } = nestBinding({ checker, keys, file, dependencies: scan.dependencies }, returned.model);
    if (primitive || id === '') return;
    scan.edits.push(insertion(method.getStart(file), `@${REWRITE_IMPORT_PREFIX}${NEST_RETURN_DECORATOR}(${JSON.stringify(id)}${returned.array ? ', true' : ''}) `));
    importOf(scan, root, file, method, NEST_RETURN_DECORATOR, NEST_MODULE);
    loadCodecModule(scan, { root, checker, keys, file }, id, name);
  };

  const visit = (node: ts.Node): void => {
    if (nest && ts.isParameter(node)) visitParameter(node);
    else if (nest && ts.isMethodDeclaration(node)) visitMethod(node);
    if (ts.isCallExpression(node)) visitCall(node);
    else if (ts.isClassDeclaration(node) && node.name) {
      const found = registeredModelOf({ checker, keys }, file, node as ts.ClassDeclaration & { readonly name: ts.Identifier }, scan.dependencies);
      if (found !== undefined) {
        classes.push({ name: node.name.text, id: found.id, end: node.end });
        scan.dependencies.add(portable(root, found.base.file));
      }
    } else if (ts.isIdentifier(node) && !reserved && node.text.startsWith(REWRITE_IMPORT_PREFIX)) reserved = node;
    ts.forEachChild(node, (child) => { visit(child); return undefined; });
  };
  visit(file);

  // One class registers as its model's class; with several, in this file or in others, each registers as <id>#<class> and the model has no default.
  const linked = classes.length > 0 ? input.modelClasses() : new Map<string, number>();
  for (const { name, id, end } of classes) {
    const key = (linked.get(id) ?? 0) > 1 ? `${id}#${name}` : id;
    const statement = `registerIModelClass(${JSON.stringify(key)}, ${name});`;
    // This also matches the aliased statement an earlier rewrite wrote.
    if (text.includes(statement)) continue;
    scan.edits.push(insertion(end, `\n${REWRITE_IMPORT_PREFIX}${statement}`));
    importOf(scan, root, file, file, 'registerIModelClass', SERDE_MODULE);
  }

  // A user binding of the reserved prefix would capture the call the rewrite inserts, so a file that is rewritten may not use one.
  if (reserved && scan.edits.length > 0) {
    scan.diagnostics.push(locate(root, file, reserved, CODE_RESERVED_PREFIX,
      `"${reserved.text}" starts with ${REWRITE_IMPORT_PREFIX}, which golem reserves for the names it adds when it rewrites a file. Rename it.`));
  }
  return scan;
}

// The scan

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** What one file needs rewritten, answered per file from the program the scanner holds. */
export interface FileScanResult extends FileRewrite {
  readonly diagnostics: readonly GolemDiagnostic[];
  /** Every parameter the nest rule stamps in this file; empty unless `nest` is on. */
  readonly nestCodecSites: readonly NestCodecSite[];
  /** Root-relative key tables and generated model modules the edits were resolved from, sorted. A change to one of them can change this file's edits. */
  readonly dependencies: readonly string[];
}

function resultOf(scan: FileScan): FileScanResult {
  const byModule = new Map<string, string[]>();
  for (const [name, from] of scan.imports) byModule.set(from, [...(byModule.get(from) ?? []), name]);
  for (const from of scan.loads) if (!byModule.has(from)) byModule.set(from, []);
  const imports: RewriteImport[] = [...byModule]
    .sort(([left], [right]) => compareText(left, right))
    .map(([from, names]) => ({ from, names: names.sort(compareText) }));
  const edits = [...scan.edits].sort((left, right) => left.start - right.start || left.end - right.end);
  return { edits, imports, diagnostics: scan.diagnostics, nestCodecSites: scan.nestSites, dependencies: [...scan.dependencies].sort(compareText) };
}

/**
 * The program's own sources: what `golem build` stages and `golem check` scans. A package the program reaches through
 * node_modules, a workspace package linked there included, is an external library that its own golem build builds.
 */
export function projectSources(program: ts.Program): ts.SourceFile[] {
  return program.getSourceFiles().filter((file) => !program.isSourceFileDefaultLibrary(file)
    && !program.isSourceFileFromExternalLibrary(file)
    && !file.fileName.split(/[\\/]/).includes('node_modules'));
}

/** `noEmit` and `emitDeclarationOnly` leave no JavaScript to emit: `golem build` stages nothing then. */
export function emitsJavaScript(options: ts.CompilerOptions): boolean {
  return options.noEmit !== true && options.emitDeclarationOnly !== true;
}

/** Finds the rewrite sites of the files of one program. A file's text is the program's own; the codec keys come from `codecKeysFile` and the manifests the program advertises. */
export class RewriteScanner {
  private readonly root: string;
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly nest: boolean;
  private readonly keys: CodecKeys;
  private readonly boundary: ModelBoundary;
  private modelClassCounts: ReadonlyMap<string, number> | undefined;

  constructor(input: ScanInput) {
    this.root = input.root;
    this.boundary = modelBoundary(input.modelsRoot, input.suffixes, input.output === undefined ? undefined : { directory: input.directory, output: input.output });
    this.program = input.program;
    this.checker = input.checker;
    this.nest = input.nest;
    this.keys = new CodecKeys(input.program, input.checker, input.root, input.codecKeysFile, this.boundary);
  }

  private candidate(file: ts.SourceFile): boolean {
    return !file.isDeclarationFile
      && !this.program.isSourceFileDefaultLibrary(file)
      && !file.fileName.split(/[\\/]/).includes('node_modules')
      && !isGeneratedCompanion(file.fileName);
  }

  /**
   * The model classes of every candidate file of the program: a class registers by how many classes its model has in all of them.
   * A model class extends a base, which a renamed re-export may rename, so only a file whose text has both `class` and `extends` is walked: `extends` alone is in almost every file (generics, interfaces), and each edit makes a new scanner.
   */
  private modelClasses(): ReadonlyMap<string, number> {
    return this.modelClassCounts ??= countModelClasses({ checker: this.checker, keys: this.keys }, this.program.getSourceFiles().filter((file) => this.candidate(file) && file.text.includes('class') && file.text.includes('extends')));
  }

  private scan(file: ts.SourceFile): FileScanResult {
    return resultOf(scanFile({ root: this.root, checker: this.checker, keys: this.keys, nest: this.nest, boundary: this.boundary, modelClasses: () => this.modelClasses() }, file));
  }

  /**
   * `filename` is an absolute path. Undefined for a file that is not a rewrite candidate: not in the program, a declaration file, under node_modules, or a generated companion.
   * node_modules is judged by the file's own path, which the compiler resolves through symlinks: a workspace package
   * linked into node_modules is `isSourceFileFromExternalLibrary` yet lies elsewhere, and a host loading it rewrites its sites.
   */
  scanFile(filename: string): FileScanResult | undefined {
    const file = this.program.getSourceFile(filename);
    return file && this.candidate(file) ? this.scan(file) : undefined;
  }

  /** Every project source that needs a rewrite, by root-relative POSIX path in path order, and the diagnostics of all candidates in the same order: what `golem build` stages and rewrites. */
  scanProgram(): { readonly files: ReadonlyMap<string, FileScanResult>; readonly diagnostics: readonly GolemDiagnostic[] } {
    return this.scanFiles(projectSources(this.program).map((file) => file.fileName));
  }

  /** As `scanProgram`, for the named absolute paths: the files a caller emits, which need not be all the program reaches. Non-candidates are skipped. */
  scanFiles(filenames: readonly string[]): { readonly files: ReadonlyMap<string, FileScanResult>; readonly diagnostics: readonly GolemDiagnostic[] } {
    const sources = filenames.flatMap((filename) => this.program.getSourceFile(filename) ?? [])
      .filter((file) => this.candidate(file))
      .map((file) => ({ file, relative: portable(this.root, file.fileName) }))
      .sort((left, right) => compareText(left.relative, right.relative));
    const files = new Map<string, FileScanResult>();
    const diagnostics: GolemDiagnostic[] = [];
    for (const { file, relative } of sources) {
      const result = this.scan(file);
      diagnostics.push(...result.diagnostics);
      if (result.edits.length > 0) files.set(relative, result);
    }
    return { files, diagnostics };
  }
}

/** The scanner's answer for a whole project, with the nest sites `checkNestCodecs` reads. */
export interface ProgramScan {
  readonly files: ReadonlyMap<string, FileScanResult>;
  readonly diagnostics: readonly GolemDiagnostic[];
  readonly nestCodecSites: readonly NestCodecSite[];
}

/**
 * The `@Body()` and `@Query()` parameters whose codec id no controllers job's generated operation codecs hold. The id the scan stamps and the id the controllers job writes come
 * from separate analyses, so a mismatch means the decorators and the generated operations disagree. A missing registry
 * disagrees with every site. `roots` are the controllers job roots whose registries the project's sites may belong to.
 */
export function checkNestCodecs(roots: string | readonly string[], scanned: { readonly nestCodecSites: readonly NestCodecSite[] }): GolemDiagnostic[] {
  const registries = (typeof roots === 'string' ? [roots] : roots).flatMap((root) => {
    try {
      return [fs.readFileSync(operationCodecRegistryPath(root), 'utf8')];
    } catch {
      return [];
    }
  });
  return scanned.nestCodecSites
    .filter((site) => !registries.some((registry) => registry.includes(JSON.stringify(site.id))))
    .map((site) => ({
      code: CODE_NEST_REGISTRY,
      severity: GolemDiagnosticSeverity.Error,
      message: `@${site.decorator}() type ${site.label} disagrees with generated operation keys`,
      file: site.file,
      line: site.line,
      column: site.column,
    }));
}

/** What opening a project's program for a scan needs. */
interface ProjectScanInput {
  readonly root: string;
  /** The directory of the golem.yaml. */
  readonly directory: string;
  /** `models.root` of the project's models job. */
  readonly modelsRoot: string;
  /** The `suffixes` of the models job. Defaults to the golem default. */
  readonly suffixes?: readonly string[] | undefined;
  /** `models.output` of the project's models job. */
  readonly output?: string | undefined;
  /** The tsconfig whose files are scanned, from the golem.yaml; its directory is what the file paths are relative to. */
  readonly configFile: string;
  readonly nest: boolean;
  /** The yaml's `.golem/codec-keys.json`. */
  readonly codecKeysFile: string;
  /** The session and owner of the job that reads this project, so one compiler serves its generation and this scan; the session is kept under `root`. */
  readonly session?: GeneratorSession;
  readonly sessionOwner?: string;
}

/** Open the project's program and ask the scanner about its sources: what `golem check` reports. Writes nothing. */
export function scanProject(input: ProjectScanInput): ProgramScan {
  const { root, directory, modelsRoot, suffixes, output, configFile, nest, codecKeysFile, session, sessionOwner } = input;
  const info = createProjectProgram(root, undefined, sessionOwner === undefined ? undefined : retainedProgramSession(session, sessionOwner, root), configFile);
  using program = info.program;
  const { files, diagnostics } = new RewriteScanner({ root: path.dirname(configFile), directory, modelsRoot, suffixes, output, program, checker: program.getTypeChecker(), nest, codecKeysFile }).scanProgram();
  return { files, diagnostics, nestCodecSites: [...files.values()].flatMap((file) => file.nestCodecSites) };
}
