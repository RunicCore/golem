import * as ts from '../typescript-ns.js';
import { canonicalFilename, generatedFilename } from './project.js';
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
  const expected = new Set(specifications.map(specification => canonicalFilename(generatedFilename(specification.sourceFile.fileName))));
  const match = (filename: string, name: string | undefined): ModelSpecification | undefined => specifications.find(specification =>
    canonicalFilename(generatedFilename(specification.sourceFile.fileName)) === canonicalFilename(filename)
      && name === `${specification.name}BaseModel`);
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    fileExists: filename => expected.has(canonicalFilename(filename)) || ts.sys.fileExists(filename),
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
        const module = ts.resolveModuleName(statement.moduleSpecifier.text, statement.getSourceFile().fileName, compilerOptions, host).resolvedModule;
        const specification = module && match(module.resolvedFileName, (alias.propertyName ?? alias.name).text);
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
