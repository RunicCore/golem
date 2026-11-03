import * as ts from '../typescript-ns.js';
import { evaluateStaticValue } from '../static-value.js';
import { owningPackageName } from './package-specifier.js';
import { resolveSymbol } from './symbols.js';

/**
 * What a package that reads controller decorators takes from them, and nothing it judges: which decorator a node
 * carries, which key it names and which type an array holds. Whether a type is a model stays in each job. The caller
 * names the packages whose decorators it reads.
 */

/** The decorator's own expression: the callee of `@Name(...)`, or `Name` of `@Name`. */
export function decoratorCallee(decorator: ts.Decorator): ts.Expression {
  return ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
}

function importedPackageFromDeclaration(declaration: ts.Declaration): string | undefined {
  let current: ts.Node | undefined = declaration;
  while (current) {
    if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) {
      return current.moduleSpecifier.text;
    }
    if (ts.isImportSpecifier(current) || ts.isNamespaceImport(current) || ts.isImportClause(current)) {
      const parent = current.parent;
      if (ts.isNamedImports(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent)) {
        const importDeclaration = parent.parent;
        if (ts.isImportDeclaration(importDeclaration) && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
          return importDeclaration.moduleSpecifier.text;
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

function canonicalPackage(source: string | undefined, packages: readonly string[]): string | undefined {
  if (!source) return undefined;
  return packages.find((decoratorPackage) => source === decoratorPackage || source.startsWith(`${decoratorPackage}/`));
}

function calleeSymbol(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
}

/** The one of `packages` that an expression's symbol comes from, through an import (also a namespace import), an alias or a re-export. */
export function decoratorPackageOf(checker: ts.TypeChecker, expression: ts.Expression, packages: readonly string[]): string | undefined {
  const symbol = calleeSymbol(checker, expression);
  const receiver = ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.expression) : undefined;
  for (const declaration of [...symbol?.declarations ?? [], ...receiver?.declarations ?? []]) {
    const decoratorPackage = canonicalPackage(importedPackageFromDeclaration(declaration), packages);
    if (decoratorPackage) return decoratorPackage;
  }
  // Through a re-export, the package is the one that owns the declaring file, wherever it is installed or mapped to.
  for (const declaration of resolveSymbol(checker, symbol)?.declarations ?? []) {
    const decoratorPackage = canonicalPackage(owningPackageName(declaration.getSourceFile().fileName), packages);
    if (decoratorPackage) return decoratorPackage;
  }
  return undefined;
}

export interface DecoratorIdentity {
  /** The name the decorator is declared with, not the name it is imported or called by. */
  readonly name?: string;
  /** The one of the caller's packages that the decorator comes from. */
  readonly packageName?: string;
}

/** Which decorator a node is, by its resolved symbol: an aliased, namespaced or re-exported import is the decorator it resolves to. A decorator of any other package has no `packageName`. */
export function decoratorIdentity(checker: ts.TypeChecker, decorator: ts.Decorator, packages: readonly string[]): DecoratorIdentity {
  const expression = decoratorCallee(decorator);
  const symbol = calleeSymbol(checker, expression);
  const name = resolveSymbol(checker, symbol)?.getName() ?? symbol?.getName();
  const packageName = decoratorPackageOf(checker, expression, packages);
  return { ...(name ? { name } : {}), ...(packageName ? { packageName } : {}) };
}

/** The key `@Body('key')`-style decorators name when it is a static non-empty string; a pipe, a computed key, an empty string or no argument names none. */
export function staticDecoratorKey(checker: ts.TypeChecker, decorator: ts.Decorator): string | undefined {
  const argument = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
  const key = argument === undefined ? undefined : evaluateStaticValue(checker, argument);
  // An empty key names no field: the framework reads @Body('') as a whole body.
  return key?.ok === true && typeof key.value === 'string' && key.value !== '' ? key.value : undefined;
}

/** The item type node of `T[]`, `Array<T>`, `ReadonlyArray<T>` or a qualified spelling such as `globalThis.Array<T>`, through parentheses and `readonly`; one level. */
export function arrayItemNode(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (node === undefined) return undefined;
  if (ts.isParenthesizedTypeNode(node)) return arrayItemNode(node.type);
  if (ts.isTypeOperatorNode(node)) return node.operator === ts.SyntaxKind.ReadonlyKeyword ? arrayItemNode(node.type) : undefined;
  let item: ts.TypeNode | undefined;
  if (ts.isArrayTypeNode(node)) item = node.elementType;
  else if (ts.isTypeReferenceNode(node) && ['Array', 'ReadonlyArray'].includes(ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text)) item = node.typeArguments?.length === 1 ? node.typeArguments[0] : undefined;
  while (item !== undefined && ts.isParenthesizedTypeNode(item)) item = item.type;
  return item;
}
