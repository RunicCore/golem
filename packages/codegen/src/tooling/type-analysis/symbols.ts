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
    return /\/(?:@exprtlabs\/)?codegen\/(?:src|dist)\/model\.(?:d\.)?ts$/.test(filename);
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
      && name === `${specification.name}Base`);
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
