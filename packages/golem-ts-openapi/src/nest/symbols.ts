import * as ts from '@exprtlabs/golem/ts';
import { resolveSymbol } from '@exprtlabs/golem/type-analysis';
import { unwrapExpression } from '../evaluation/static-value.js';
import type { DecoratorInfo } from './types.js';

export const NEST_COMMON = '@nestjs/common' as const;
export const NEST_SWAGGER = '@nestjs/swagger' as const;
type NestPackage = typeof NEST_COMMON | typeof NEST_SWAGGER;

function expressionOfDecorator(decorator: ts.Decorator): ts.Expression {
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

export function nestPackageOf(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): string | undefined {
  const symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(expression) ? expression.name : expression,
  );
  if (!symbol) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    const imported = importedPackageFromDeclaration(declaration);
    const nestPackage = canonicalNestPackage(imported);
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

function decoratorInfo(
  checker: ts.TypeChecker,
  decorator: ts.Decorator,
): DecoratorInfo {
  const expression = expressionOfDecorator(decorator);
  const symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(expression) ? expression.name : expression,
  );
  const target = resolveSymbol(checker, symbol);
  const name = target?.getName() ?? symbol?.getName();
  const packageName = nestPackageOf(checker, expression);
  return {
    decorator,
    expression,
    ...(ts.isCallExpression(decorator.expression) ? { call: decorator.expression } : {}),
    ...(name ? { name } : {}),
    ...(packageName ? { packageName } : {}),
  };
}

export function decoratorsOf(checker: ts.TypeChecker, node: ts.Node): readonly DecoratorInfo[] {
  if (!ts.canHaveDecorators(node)) return [];
  return (ts.getDecorators(node) ?? []).map((decorator) => decoratorInfo(checker, decorator));
}

export function callArguments(info: DecoratorInfo): readonly ts.Expression[] {
  return info.call?.arguments ? [...info.call.arguments] : [];
}

function objectLiteralProperty(
  node: ts.ObjectLiteralExpression | undefined,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  const property = node?.properties.find((item) => {
    if (!ts.isPropertyAssignment(item) && !ts.isShorthandPropertyAssignment(item)) return false;
    if (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name) || ts.isNumericLiteral(item.name)) {
      return item.name.text === name;
    }
    return false;
  });
  return property;
}

export function propertyInitializer(
  node: ts.ObjectLiteralExpression | undefined,
  name: string,
): ts.Expression | undefined {
  const property = objectLiteralProperty(node, name);
  if (!property) return undefined;
  return ts.isPropertyAssignment(property)
    ? property.initializer
    : ts.isShorthandPropertyAssignment(property)
      ? property.name as ts.Expression
      : undefined;
}

/** The object literal an expression spells, looking through value-preserving syntax. */
export function staticObject(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  const value = node && unwrapExpression(node);
  return value && ts.isObjectLiteralExpression(value) ? value : undefined;
}
