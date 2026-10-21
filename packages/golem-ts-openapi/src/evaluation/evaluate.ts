import type * as ts from '@exprtlabs/golem/internal/ts';
import {
  assertRouteResultSize,
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
  options.onInput?.(expression.getSourceFile().fileName);
  const literal = isLiteralRouteExpression(expression);
  const value = literal ?? foldRouteExpression(expression, program, options);
  assertRouteResultSize(value, maxResultBytes, expression);
  return value;
}
