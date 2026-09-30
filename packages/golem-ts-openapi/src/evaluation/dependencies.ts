import * as ts from '@exprtlabs/golem/ts';
import { TsToOpenApiDiagnosticCode, TsToOpenApiError, diagnostic } from '../diagnostics.js';

export const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;

export interface RouteEvaluationOptions {
  readonly maxResultBytes?: number;
  readonly onInput?: (path: string) => void;
}

export function bindExpressionSource(expression: ts.Expression, program: ts.Program): ts.SourceFile {
  program.getTypeChecker();
  const sourceFile = expression.getSourceFile();
  if (sourceFile) return sourceFile;
  throw new TsToOpenApiError(diagnostic(
    undefined,
    undefined,
    TsToOpenApiDiagnosticCode.UnboundRouteExpression,
    'Route expression is not bound to a TypeScript program source file.',
  ));
}

export function validateRouteEvaluationOptions(options: RouteEvaluationOptions = {}): {
  readonly maxResultBytes: number;
} {
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0) {
    throw new TypeError('maxResultBytes must be a positive safe integer.');
  }
  return { maxResultBytes };
}

export function assertRouteResultSize(
  value: string | string[],
  maxResultBytes: number,
  expression: ts.Expression,
  program: ts.Program,
): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxResultBytes) return;
  throw new TsToOpenApiError(diagnostic(
    bindExpressionSource(expression, program),
    expression,
    TsToOpenApiDiagnosticCode.RouteResultTooLarge,
    'Route expression result exceeds maxResultBytes.',
  ));
}

export function isLiteralRouteExpression(expression: ts.Expression): string | string[] | undefined {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isArrayLiteralExpression(expression)) return undefined;
  if (expression.elements.every((element) => ts.isStringLiteralLike(element))) {
    return expression.elements.map((element) => (element as ts.StringLiteralLike).text);
  }
  return undefined;
}
