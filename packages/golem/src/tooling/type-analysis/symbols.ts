import * as ts from '../typescript-ns.js';
import { DEFAULT_MODEL_SUFFIXES, canonicalPath, displayPath } from '../generator-core.js';
import { canonicalFilename, generatedFilename, isModelFileName, type ModelBoundary } from './project.js';
import type { ModelSpecification } from './models.js';
import { isGolemSourceFile, isGolemTagKey } from './tags.js';
import { hasLocalForm, localFormMessage } from '../names.js';

/** A located model-analysis error with its RUNM code. */
export function namedDiagnostic(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: string,
  message: string,
): Error & { readonly code: string } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const error = new Error(
    `${displayPath(sourceFile.fileName)}:${position.line + 1}:${position.character + 1} ${code}: ${message}`,
  ) as Error & { readonly code: string };
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

export function diagnostic(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: string,
  message: string,
): Error & { readonly code: string } {
  return namedDiagnostic(sourceFile, node, `RUNM${code}`, message);
}

/** The declared type of a property, read at its own declaration. */
export function propertyType(
  checker: ts.TypeChecker,
  property: ts.Symbol,
  location: ts.Node,
): ts.Type {
  const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
  return checker.getTypeOfSymbolAtLocation(property, declaration);
}

/** Resolve imported aliases without using the local spelling of a declaration. */
export function resolveSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  const seen = new Set<ts.Symbol>();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

export function isModelDeclarationReference(checker: ts.TypeChecker, node: ts.TypeNode): boolean {
  return modelDeclarationKind(checker, node) !== undefined;
}

export function modelDeclarationKind(checker: ts.TypeChecker, node: ts.TypeNode): 'IModel' | 'IObject' | undefined {
  if (!ts.isTypeReferenceNode(node)) return undefined;
  const symbol = resolveSymbol(checker, checker.getSymbolAtLocation(node.typeName));
  const name = symbol?.getName();
  if (name !== 'IModel' && name !== 'IObject') return undefined;
  return (symbol?.declarations ?? []).some(isGolemModelSource) ? name : undefined;
}

function isGolemModelSource(declaration: ts.Declaration): boolean {
  return isGolemSourceFile(declaration.getSourceFile().fileName, 'model');
}

/** The unique symbols model.ts declares for the type-only members of a generated model. */
const GENERATED_BRAND_SYMBOLS: ReadonlySet<string> = new Set(['generatedModelWireBrand', 'generatedModelFieldsBrand']);

/**
 * Whether `property` is a type-only brand member of a generated model: a property whose key is one of the unique symbols that
 * model.ts declares. The key is found by its resolved symbol, so a string key spelled like a brand stays a field.
 */
export function isGeneratedBrandKey(checker: ts.TypeChecker, property: ts.Symbol): boolean {
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  const key = declaration && (declaration as ts.NamedDeclaration).name;
  if (key === undefined || !ts.isComputedPropertyName(key)) return false;
  const target = resolveSymbol(checker, checker.getSymbolAtLocation(key.expression));
  return target !== undefined && GENERATED_BRAND_SYMBOLS.has(target.getName()) && (target.declarations ?? []).some(isGolemModelSource);
}


/**
 * Why golem cannot generate `declaration`, an IModel or IObject alias that no model of this job declares, or undefined when
 * the declaration has no such reason: a type that is only nested without a name, for one. A model is `file#export`, with the
 * real path of the file. The one reason: the file name has no model suffix, so golem does not read the file as a model file.
 * Without a boundary (an analysis that has no models job, such as the controllers analysis) the default suffixes apply.
 */
export function foreignModelReason(declaration: ts.TypeAliasDeclaration, boundary: Pick<ModelBoundary, 'suffixes'> | undefined): string | undefined {
  const filename = canonicalPath(declaration.getSourceFile().fileName);
  const suffixes = boundary?.suffixes ?? DEFAULT_MODEL_SUFFIXES;
  if (isModelFileName({ suffixes }, filename)) return undefined;
  return `${displayPath(filename)}#${declaration.name.text} is declared in a file whose name has no model suffix. Golem reads a model from a file whose name ends in ${suffixes.join(' or ')}. Move the model into such a file.`;
}

/** The alias that declares the model the type reference names, when it is written as `type Name = IModel<...>` or `IObject<...>`. */
export function declaredModelAlias(reference: ts.TypeReferenceNode): ts.TypeAliasDeclaration | undefined {
  return ts.isTypeAliasDeclaration(reference.parent) && reference.parent.type === reference ? reference.parent : undefined;
}


/** The generated companion of a model: beside its file, or where the job put a shared file's. */
export function companionOfSpecification(specification: ModelSpecification): string {
  return specification.companionFile ?? generatedFilename(specification.sourceFile.fileName);
}

/** Identify a model class through its generated base import, including first generation. */
export function modelSpecificationForClass(
  checker: ts.TypeChecker,
  type: ts.Type,
  specifications: readonly ModelSpecification[],
  seen = new Set<ts.ClassDeclaration>(),
): ModelSpecification | undefined {
  const declaration = resolveSymbol(checker, type.getSymbol())?.declarations?.find(ts.isClassDeclaration);
  if (!declaration || seen.has(declaration)) return undefined;
  seen.add(declaration);
  // The companions the jobs are about to write do not exist on the first run, so the compiler finds no module for an import of one; the
  // lookup that counts them covers every import form (relative, `paths`, `#imports`). Built when the first import needs it.
  let expected: ReadonlySet<string> | undefined;
  const match = (filename: string, name: string | undefined): ModelSpecification | undefined => specifications.find(specification =>
    canonicalFilename(companionOfSpecification(specification)) === canonicalFilename(filename)
      && name === `${specification.name}BaseModel`);
  for (const heritage of declaration.heritageClauses ?? []) {
    if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const base of heritage.types) {
      const symbol = checker.getSymbolAtLocation(base.expression);
      const resolved = resolveSymbol(checker, symbol);
      for (const target of resolved?.declarations ?? []) {
        const specification = match(target.getSourceFile().fileName, resolved?.name);
        if (specification) return specification;
      }
      for (const alias of symbol?.declarations ?? []) {
        if (!ts.isImportSpecifier(alias)) continue;
        const statement = alias.parent.parent.parent;
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
        const resolved = checker.resolveImport(statement.moduleSpecifier, expected ??= new Set(specifications.map(specification => canonicalFilename(companionOfSpecification(specification)))))?.resolvedFileName;
        const specification = resolved && match(resolved, (alias.propertyName ?? alias.name).text);
        if (specification) return specification;
      }
      const inherited = modelSpecificationForClass(checker, checker.getTypeAtLocation(base), specifications, seen);
      if (inherited) return inherited;
    }
  }
  return undefined;
}

/**
 * Every exported class of the model's file that extends the model's generated base, whatever its
 * name. A class that extends another such class is a subclass and does not link.
 */
export function linkedClasses(
  checker: ts.TypeChecker,
  specification: ModelSpecification,
  specifications: readonly ModelSpecification[],
): Array<ts.ClassDeclaration & { readonly name: ts.Identifier }> {
  const candidates = specification.sourceFile.statements.filter((statement): statement is ts.ClassDeclaration & { readonly name: ts.Identifier } =>
    ts.isClassDeclaration(statement)
      && statement.name !== undefined
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
      && modelSpecificationForClass(checker, checker.getTypeAtLocation(statement.name), specifications) === specification);
  const extendsCandidate = (candidate: ts.ClassDeclaration): boolean => (candidate.heritageClauses ?? [])
    .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((clause) => clause.types)
    .some((base) => {
      const symbol = checker.getSymbolAtLocation(base.expression);
      const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return (resolved?.declarations ?? []).some((declaration) => candidates.some((other) => other === declaration));
    });
  return candidates.filter((candidate) => !extendsCandidate(candidate));
}

/** The names of `linkedClasses`. */
export function linkedClassNames(
  checker: ts.TypeChecker,
  specification: ModelSpecification,
  specifications: readonly ModelSpecification[],
): string[] {
  return linkedClasses(checker, specification, specifications).map((candidate) => candidate.name.text);
}

/** Stops with RUNM1088 at the exported class `name` of the model's file when its name has the form of a local of generated code: a companion that uses the class imports it under that name. */
export function assertImportableClassName(specification: ModelSpecification, name: string): void {
  if (!hasLocalForm(name)) return;
  const declaration = specification.sourceFile.statements.find((statement): statement is ts.ClassDeclaration & { readonly name: ts.Identifier } => ts.isClassDeclaration(statement) && statement.name?.text === name);
  throw diagnostic(specification.sourceFile, declaration?.name ?? specification.declaration, '1088', localFormMessage(name, 'The class'));
}

/** The model's default class: its only linked class. A model with several has none. */
export function exportedConcreteClass(
  checker: ts.TypeChecker,
  specification: ModelSpecification,
  specifications: readonly ModelSpecification[],
): string | undefined {
  const linked = linkedClassNames(checker, specification, specifications);
  return linked.length === 1 ? linked[0] : undefined;
}

/** Whether `property` is a data property keyed by a symbol, such as `[sym]: string` or the `[Symbol.toStringTag]` of a built-in type. */
export function isSymbolKeyedProperty(checker: ts.TypeChecker, property: ts.Symbol): boolean {
  if ((property.flags & ts.SymbolFlags.Method) !== 0) return false;
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  const key = declaration && (declaration as ts.NamedDeclaration).name;
  if (key === undefined || !ts.isComputedPropertyName(key)) return false;
  return (checker.getTypeAtLocation(key.expression).flags & ts.TypeFlags.UniqueESSymbol) !== 0;
}

/**
 * Whether a symbol-keyed property is one that the user wrote and JSON cannot carry. A generated-model brand key and a golem tag
 * key are type-only members that no model or parameter carries, so they are not counted.
 */
export function isUnsupportedSymbolKey(checker: ts.TypeChecker, property: ts.Symbol): boolean {
  return isSymbolKeyedProperty(checker, property) && !isGeneratedBrandKey(checker, property) && !isGolemTagKey(checker, property);
}

/** Whether only a default library file declares `property`: the built-in type's own metadata, such as the `[Symbol.toStringTag]` of `Uint8Array`. */
export function isDefaultLibraryProperty(property: ts.Symbol, isDefaultLibraryFile: (file: ts.SourceFile) => boolean): boolean {
  const declarations = property.declarations ?? [];
  return declarations.length > 0 && declarations.every(declaration => isDefaultLibraryFile(declaration.getSourceFile()));
}

/** Stops generation when `property` has a symbol key; `owner` names the model or parameter and `node` is where the error points. */
export function assertNoSymbolKey(checker: ts.TypeChecker, property: ts.Symbol, owner: string, sourceFile: ts.SourceFile, node: ts.Node): void {
  if (!isUnsupportedSymbolKey(checker, property)) return;
  const key = ((property.valueDeclaration ?? property.declarations?.[0]) as ts.NamedDeclaration).name!.getText();
  throw diagnostic(sourceFile, node, '1070', `${owner} has the property ${key} with a symbol key. JSON cannot carry a symbol key. Use a string key, or remove the property.`);
}
