import * as ts from '@exprtlabs/golem/internal/ts';
import { NEST_COMMON, NEST_SWAGGER, decoratorCallee, decoratorIdentity } from '@exprtlabs/golem/internal/type-analysis';
import { unwrapExpression } from '@exprtlabs/golem/internal/static-value';
import type { DecoratorInfo } from './types.js';

export { NEST_COMMON, NEST_SWAGGER };

function decoratorInfo(
  checker: ts.TypeChecker,
  decorator: ts.Decorator,
): DecoratorInfo {
  return {
    decorator,
    expression: decoratorCallee(decorator),
    ...(ts.isCallExpression(decorator.expression) ? { call: decorator.expression } : {}),
    ...decoratorIdentity(checker, decorator),
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
