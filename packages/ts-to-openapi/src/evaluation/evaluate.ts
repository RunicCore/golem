import type * as ts from '@exprtlabs/codegen/ts';
import {
  assertRouteResultSize,
  bindExpressionSource,
  isLiteralRouteExpression,
  validateRouteEvaluationOptions,
  type RouteEvaluationOptions,
} from './dependencies.js';
import { foldRouteExpression } from './fold.js';

export type { RouteEvaluationOptions } from './dependencies.js';

/**
 * Evaluate a route path or version expression: a string literal, an array of
 * literals, or a simple helper folded statically by `foldRouteExpression`.
 */
export async function evaluateRouteExpression(
  expression: ts.Expression,
  program: ts.Program,
  options: RouteEvaluationOptions = {},
): Promise<string | string[]> {
  const { maxResultBytes } = validateRouteEvaluationOptions(options);
  const sourceFile = bindExpressionSource(expression, program);
  options.onInput?.(sourceFile.fileName);
  const literal = isLiteralRouteExpression(expression);
  const value = literal ?? foldRouteExpression(expression, program, options);
  assertRouteResultSize(value, maxResultBytes, expression, program);
  return value;
}
