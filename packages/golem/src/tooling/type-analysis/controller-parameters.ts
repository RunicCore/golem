import * as ts from '../typescript-ns.js';
import { evaluateStaticValue } from '../static-value.js';
import { resolveSymbol } from './symbols.js';

/**
 * What the controllers job and the rewrite scan both read from a NestJS controller parameter, and nothing they judge:
 * which decorator a node carries, which key it names and which type an array holds. Whether a type is a model stays
 * in each job.
 */

export const NEST_COMMON = '@nestjs/common' as const;
export const NEST_SWAGGER = '@nestjs/swagger' as const;
type NestPackage = typeof NEST_COMMON | typeof NEST_SWAGGER;

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

function canonicalNestPackage(source: string | undefined): NestPackage | undefined {
  if (!source) return undefined;
  for (const nestPackage of [NEST_COMMON, NEST_SWAGGER]) {
    if (source === nestPackage || source.startsWith(`${nestPackage}/`)) return nestPackage;
  }
  return undefined;
}

function calleeSymbol(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
}

/** The NestJS package an expression's symbol comes from, through an import, an alias or a re-export. A module that does not resolve leaves its import to say. */
export function nestPackageOf(checker: ts.TypeChecker, expression: ts.Expression): NestPackage | undefined {
  const symbol = calleeSymbol(checker, expression) ?? (ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.expression) : undefined);
  if (!symbol) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    const nestPackage = canonicalNestPackage(importedPackageFromDeclaration(declaration));
    if (nestPackage) return nestPackage;
  }
  const target = resolveSymbol(checker, symbol);
  for (const declaration of target?.declarations ?? []) {
    const source = declaration.getSourceFile().fileName.replace(/\\/g, '/');
    if (source.includes(`/node_modules/${NEST_COMMON}/`)) return NEST_COMMON;
    if (source.includes(`/node_modules/${NEST_SWAGGER}/`)) return NEST_SWAGGER;
  }
  return undefined;
}

function importedName(symbol: ts.Symbol | undefined): string | undefined {
  const specifier = symbol?.declarations?.find(ts.isImportSpecifier);
  return specifier === undefined ? undefined : (specifier.propertyName ?? specifier.name).text;
}

export interface DecoratorIdentity {
  /** The name the decorator is declared with, not the name it is imported or called by. */
  readonly name?: string;
  readonly packageName?: NestPackage;
}

/** Which decorator a node is, by its resolved symbol: an aliased, namespaced or re-exported import is the decorator it resolves to. */
export function decoratorIdentity(checker: ts.TypeChecker, decorator: ts.Decorator): DecoratorIdentity {
  const expression = decoratorCallee(decorator);
  const symbol = calleeSymbol(checker, expression);
  const target = resolveSymbol(checker, symbol);
  // A module that does not resolve has no declaration to follow; the name its import names stands for it.
  const name = target?.declarations?.length ? target.getName() : importedName(symbol) ?? (ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined);
  const packageName = nestPackageOf(checker, expression);
  return { ...(name ? { name } : {}), ...(packageName ? { packageName } : {}) };
}

/** The key `@Body('key')`-style decorators name when it is a static string; a pipe, a computed key or no argument names none. */
export function staticDecoratorKey(checker: ts.TypeChecker, decorator: ts.Decorator): string | undefined {
  const argument = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
  const key = argument === undefined ? undefined : evaluateStaticValue(checker, argument);
  return key?.ok === true && typeof key.value === 'string' ? key.value : undefined;
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
