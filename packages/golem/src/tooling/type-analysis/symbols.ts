import { dirname, resolve } from 'node:path';
import * as ts from '../typescript-ns.js';
import { DEFAULT_MODEL_SUFFIXES, canonicalPath } from '../generator-api.js';
import { canonicalFilename, generatedFilename, isModelFileName, type ModelBoundary } from './project.js';
import type { ModelSpecification } from './models.js';

/** A located model-analysis error with its RUNM code. */
export function diagnostic(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  code: string,
  message: string,
): Error & { readonly code: string } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const error = new Error(
    `${sourceFile.fileName}:${position.line + 1}:${position.character + 1} RUNM${code}: ${message}`,
  ) as Error & { readonly code: string };
  Object.defineProperty(error, 'code', { value: `RUNM${code}`, enumerable: true });
  return error;
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
  return (symbol?.declarations ?? []).some(declaration => {
    const filename = declaration.getSourceFile().fileName.replace(/\\/g, '/');
    return /\/(?:@exprtlabs\/)?golem\/(?:src|dist)\/model\.(?:d\.)?ts$/.test(filename);
  }) ? name : undefined;
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
  return `${filename}#${declaration.name.text} is declared in a file whose name has no model suffix. Golem reads a model from a file whose name ends in ${suffixes.join(' or ')}. Move the model into such a file.`;
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
  compilerOptions: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext },
  seen = new Set<ts.ClassDeclaration>(),
): ModelSpecification | undefined {
  const declaration = resolveSymbol(checker, type.getSymbol())?.declarations?.find(ts.isClassDeclaration);
  if (!declaration || seen.has(declaration)) return undefined;
  seen.add(declaration);
  const expected = new Set(specifications.map(specification => canonicalFilename(companionOfSpecification(specification))));
  const match = (filename: string, name: string | undefined): ModelSpecification | undefined => specifications.find(specification =>
    canonicalFilename(companionOfSpecification(specification)) === canonicalFilename(filename)
      && name === `${specification.name}BaseModel`);
  // Module resolution finds only a file whose folder exists, and the folder of a shared companion in `models.output` is made when
  // the models job writes it: the expected companions exist for every import form (relative, `paths`, `#imports`).
  const expectedFolders = new Set([...expected].flatMap((filename) => {
    const folders: string[] = [];
    for (let folder = dirname(filename); !folders.includes(folder); folder = dirname(folder)) folders.push(folder);
    return folders;
  }));
  // The system carries `directoryExists`, which the compiler's resolution reads and the golem-owned host type leaves out.
  const system = ts.sys as ts.ModuleResolutionHost & { directoryExists?(directory: string): boolean };
  const host = {
    ...system,
    fileExists: (filename: string) => expected.has(canonicalFilename(filename)) || system.fileExists(filename),
    directoryExists: (directory: string) => expectedFolders.has(canonicalFilename(directory)) || system.directoryExists?.(directory) === true,
  };
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
        const importer = statement.getSourceFile().fileName;
        const resolved = ts.resolveModuleName(statement.moduleSpecifier.text, importer, compilerOptions, host).resolvedModule?.resolvedFileName;
        const specification = resolved && match(resolved, (alias.propertyName ?? alias.name).text);
        if (specification) return specification;
      }
      const inherited = modelSpecificationForClass(checker, checker.getTypeAtLocation(base), specifications, compilerOptions, seen);
      if (inherited) return inherited;
    }
  }
  return undefined;
}

/**
 * Every exported class of the model's file that extends the model's generated base, whatever its
 * name. A class that extends another such class is a subclass and does not link.
 */
export function linkedClassNames(
  checker: ts.TypeChecker,
  specification: ModelSpecification,
  specifications: readonly ModelSpecification[],
  compilerOptions?: ts.CompilerOptions,
): string[] {
  const candidates = specification.sourceFile.statements.filter((statement): statement is ts.ClassDeclaration & { readonly name: ts.Identifier } =>
    ts.isClassDeclaration(statement)
      && statement.name !== undefined
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
      && modelSpecificationForClass(checker, checker.getTypeAtLocation(statement.name), specifications, compilerOptions) === specification);
  const extendsCandidate = (candidate: ts.ClassDeclaration): boolean => (candidate.heritageClauses ?? [])
    .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((clause) => clause.types)
    .some((base) => {
      const symbol = checker.getSymbolAtLocation(base.expression);
      const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return (resolved?.declarations ?? []).some((declaration) => candidates.some((other) => other === declaration));
    });
  return candidates.filter((candidate) => !extendsCandidate(candidate)).map((candidate) => candidate.name.text);
}

/** The model's default class: its only linked class. A model with several has none. */
export function exportedConcreteClass(
  checker: ts.TypeChecker,
  specification: ModelSpecification,
  specifications: readonly ModelSpecification[],
  compilerOptions?: ts.CompilerOptions,
): string | undefined {
  const linked = linkedClassNames(checker, specification, specifications, compilerOptions);
  return linked.length === 1 ? linked[0] : undefined;
}
