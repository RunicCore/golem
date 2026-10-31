import * as ts from '../typescript-ns.js';
import { evaluateStaticValue } from '../static-value.js';
import { owningPackageName } from './package-specifier.js';
import { resolveSymbol } from './symbols.js';

/**
 * What the controllers job, the model analysis and the rewrite scan read from NestJS decorators and controller
 * parameters, and nothing they judge: which decorator a node carries, which key it names and which type an array
 * holds. Whether a type is a model stays in each job.
 */

export const NEST_COMMON = '@nestjs/common' as const;
export const NEST_SWAGGER = '@nestjs/swagger' as const;
/** The package of golem's own NestJS decorators (`nestModelCodec`, `nestModelUnion`, `nestModelReturn`). */
export const GOLEM_PACKAGE = '@exprtlabs/golem' as const;
const DECORATOR_PACKAGES = [NEST_COMMON, NEST_SWAGGER, GOLEM_PACKAGE] as const;
type DecoratorPackage = (typeof DECORATOR_PACKAGES)[number];

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

function canonicalPackage(source: string | undefined): DecoratorPackage | undefined {
  if (!source) return undefined;
  return DECORATOR_PACKAGES.find((decoratorPackage) => source === decoratorPackage || source.startsWith(`${decoratorPackage}/`));
}

function calleeSymbol(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
}

/** The package an expression's symbol comes from, through an import (also a namespace import), an alias or a re-export. */
export function decoratorPackageOf(checker: ts.TypeChecker, expression: ts.Expression): DecoratorPackage | undefined {
  const symbol = calleeSymbol(checker, expression);
  const receiver = ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.expression) : undefined;
  for (const declaration of [...symbol?.declarations ?? [], ...receiver?.declarations ?? []]) {
    const decoratorPackage = canonicalPackage(importedPackageFromDeclaration(declaration));
    if (decoratorPackage) return decoratorPackage;
  }
  // Through a re-export, the package is the one that owns the declaring file, wherever it is installed or mapped to.
  for (const declaration of resolveSymbol(checker, symbol)?.declarations ?? []) {
    const decoratorPackage = canonicalPackage(owningPackageName(declaration.getSourceFile().fileName));
    if (decoratorPackage) return decoratorPackage;
  }
  return undefined;
}

export interface DecoratorIdentity {
  /** The name the decorator is declared with, not the name it is imported or called by. */
  readonly name?: string;
  readonly packageName?: DecoratorPackage;
}

/** Which decorator a node is, by its resolved symbol: an aliased, namespaced or re-exported import is the decorator it resolves to. */
export function decoratorIdentity(checker: ts.TypeChecker, decorator: ts.Decorator): DecoratorIdentity {
  const expression = decoratorCallee(decorator);
  const symbol = calleeSymbol(checker, expression);
  const name = resolveSymbol(checker, symbol)?.getName() ?? symbol?.getName();
  const packageName = decoratorPackageOf(checker, expression);
  return { ...(name ? { name } : {}), ...(packageName ? { packageName } : {}) };
}

/** The key `@Body('key')`-style decorators name when it is a static non-empty string; a pipe, a computed key, an empty string or no argument names none. */
export function staticDecoratorKey(checker: ts.TypeChecker, decorator: ts.Decorator): string | undefined {
  const argument = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
  const key = argument === undefined ? undefined : evaluateStaticValue(checker, argument);
  // An empty key names no field: Nest and the interceptor read @Body('') as a whole body.
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
