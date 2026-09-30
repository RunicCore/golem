import path from 'node:path';
import * as ts from '@exprtlabs/golem/ts';
import { resolveSymbol } from '@exprtlabs/golem/type-analysis';
import { TsToOpenApiDiagnosticCode, TsToOpenApiError, diagnostic } from '../diagnostics.js';
import { bindExpressionSource, type RouteEvaluationOptions } from './dependencies.js';
import { evaluateStaticValue, isTypeScriptLibFile, singleReturnExpression, unwrapExpression as unwrap } from './static-value.js';

type StringBinding = { readonly kind: 'string'; readonly value: string };
type ObjectBinding = { readonly kind: 'object'; readonly fields: Readonly<Record<string, string>> };
type Binding = StringBinding | ObjectBinding;

interface Scope {
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly container: ts.Node | undefined;
}

/** Deepest chain of nested helper calls folded for one route expression. */
const MAX_HELPER_DEPTH = 64;

class FoldRejection extends Error {
  constructor() {
    super('not a simple route helper');
  }
}

function reject(): never {
  throw new FoldRejection();
}

function isStatic(method: ts.MethodDeclaration): boolean {
  return method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
}

function isProjectDeclaration(declaration: ts.Node): boolean {
  const file = declaration.getSourceFile();
  return !file.isDeclarationFile && !isTypeScriptLibFile(file.fileName);
}

function functionLike(symbol: ts.Symbol): ts.FunctionLikeDeclaration | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (!isProjectDeclaration(declaration)) continue;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) {
      return declaration;
    }
    if (
      ts.isVariableDeclaration(declaration)
      && declaration.initializer
      && (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
    ) {
      return declaration.initializer;
    }
  }
  return undefined;
}

function containerOf(declaration: ts.FunctionLikeDeclaration): ts.Node | undefined {
  if (!ts.isMethodDeclaration(declaration)) return undefined;
  const parent = declaration.parent;
  if (ts.isObjectLiteralExpression(parent)) return parent;
  if (ts.isClassLike(parent)) {
    if (!isStatic(declaration)) reject();
    return parent;
  }
  return undefined;
}

function findMethod(container: ts.Node, name: string): ts.FunctionLikeDeclaration | undefined {
  if (ts.isObjectLiteralExpression(container)) {
    for (const member of container.properties) {
      if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name && member.body) {
        return member;
      }
    }
    return undefined;
  }
  if (!ts.isClassLike(container)) return undefined;
  for (const member of container.members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name) || member.name.text !== name || !member.body) continue;
    if (!isStatic(member)) continue;
    return member;
  }
  return undefined;
}

function bindPattern(name: ts.BindingName, value: Binding, bindings: Map<string, Binding>): void {
  if (ts.isIdentifier(name)) {
    bindings.set(name.text, value);
    return;
  }
  if (!ts.isObjectBindingPattern(name) || value.kind !== 'object') reject();
  for (const element of name.elements) {
    if (element.dotDotDotToken || !element.name || !ts.isIdentifier(element.name)) reject();
    const key = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.text;
    const field = value.fields[key];
    if (field === undefined) reject();
    bindings.set(element.name.text, { kind: 'string', value: field });
  }
}

function objectFields(expression: ts.Expression, scope: Scope, ctx: FoldContext): Record<string, string> | undefined {
  const unwrapped = unwrap(expression);
  if (!ts.isObjectLiteralExpression(unwrapped)) return undefined;
  const fields: Record<string, string> = {};
  for (const property of unwrapped.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) reject();
    fields[property.name.text] = evalString(property.initializer, scope, ctx);
  }
  return fields;
}

interface FoldContext {
  readonly checker: ts.TypeChecker;
  readonly onInput?: (filename: string) => void;
  readonly active: Set<string>;
}

function watchDeclaration(declaration: ts.Node, ctx: FoldContext): void {
  const file = declaration.getSourceFile();
  if (file.isDeclarationFile) return;
  ctx.onInput?.(path.normalize(file.fileName));
}

function moduleSpecifierOf(declaration: ts.Declaration): ts.Expression | undefined {
  if (ts.isImportSpecifier(declaration)) {
    const statement = declaration.parent.parent.parent;
    return ts.isImportDeclaration(statement) ? statement.moduleSpecifier : undefined;
  }
  if (ts.isExportSpecifier(declaration)) {
    const statement = declaration.parent.parent;
    return ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
  }
  return undefined;
}

function watchSymbol(symbol: ts.Symbol, checker: ts.TypeChecker, ctx: FoldContext): void {
  const pending = [symbol];
  const seen = new Set<ts.Symbol>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const declaration of current.declarations ?? []) {
      watchDeclaration(declaration, ctx);
      const specifier = moduleSpecifierOf(declaration);
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const moduleSymbol = checker.getSymbolAtLocation(specifier);
        if (moduleSymbol) {
          for (const moduleDeclaration of moduleSymbol.declarations ?? []) watchDeclaration(moduleDeclaration, ctx);
          const name = declarationName(declaration);
          const exported = name ? checker.tryGetMemberInModuleExports(name, moduleSymbol) : undefined;
          if (exported) pending.push(exported);
        }
      }
    }
    if ((current.flags & ts.SymbolFlags.Alias) !== 0) {
      const next = checker.getAliasedSymbol(current);
      if (next && next !== current) pending.push(next);
    }
  }
}

function declarationName(declaration: ts.Declaration): string {
  if ((ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration)) && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }
  return '';
}

function resolveCallee(
  callee: ts.Expression,
  scope: Scope,
  ctx: FoldContext,
): { readonly declaration: ts.FunctionLikeDeclaration; readonly container: ts.Node | undefined } {
  const unwrapped = unwrap(callee);
  if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.expression.kind === ts.SyntaxKind.ThisKeyword) {
    if (!scope.container || !ts.isIdentifier(unwrapped.name)) reject();
    const declaration = findMethod(scope.container, unwrapped.name.text);
    if (!declaration) reject();
    watchDeclaration(declaration, ctx);
    return { declaration, container: scope.container };
  }
  if (ts.isElementAccessExpression(unwrapped)) reject();
  const named = ts.isPropertyAccessExpression(unwrapped) ? unwrapped.name : unwrapped;
  const symbol = ctx.checker.getSymbolAtLocation(named);
  if (!symbol) reject();
  watchSymbol(symbol, ctx.checker, ctx);
  const declaration = functionLike(resolveSymbol(ctx.checker, symbol) ?? symbol);
  if (!declaration) reject();
  watchDeclaration(declaration, ctx);
  return { declaration, container: containerOf(declaration) };
}

function bindArguments(
  declaration: ts.FunctionLikeDeclaration,
  args: readonly ts.Expression[],
  scope: Scope,
  ctx: FoldContext,
): Map<string, Binding> {
  const parameters = declaration.parameters ?? [];
  if (parameters.some((parameter) => parameter.dotDotDotToken !== undefined)) reject();
  const bindings = new Map<string, Binding>();
  if (parameters.length === 1 && args.length === 1) {
    const fields = objectFields(args[0], scope, ctx);
    if (fields) {
      bindPattern(parameters[0].name, { kind: 'object', fields }, bindings);
      return bindings;
    }
  }
  if (args.length !== parameters.length) reject();
  for (let index = 0; index < parameters.length; index += 1) {
    bindPattern(parameters[index].name, { kind: 'string', value: evalString(args[index], scope, ctx) }, bindings);
  }
  return bindings;
}

function constString(expression: ts.Identifier, ctx: FoldContext): string {
  const result = evaluateStaticValue(ctx.checker, expression, {
    onDeclaration: declaration => watchDeclaration(declaration, ctx),
  });
  if (!result.ok || typeof result.value !== 'string') reject();
  return result.value;
}

function evalString(expression: ts.Expression, scope: Scope, ctx: FoldContext): string {
  const value = fold(expression, scope, ctx);
  if (typeof value !== 'string') reject();
  return value;
}

function fold(expression: ts.Expression, scope: Scope, ctx: FoldContext): string | string[] {
  const unwrapped = unwrap(expression);
  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.map((element) => evalString(element, scope, ctx));
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return evalString(unwrapped.left, scope, ctx) + evalString(unwrapped.right, scope, ctx);
  }
  if (ts.isTemplateExpression(unwrapped)) {
    let text = unwrapped.head.text;
    for (const span of unwrapped.templateSpans) {
      text += evalString(span.expression, scope, ctx);
      text += span.literal.text;
    }
    return text;
  }
  if (ts.isIdentifier(unwrapped)) {
    const binding = scope.bindings.get(unwrapped.text);
    if (binding?.kind === 'string') return binding.value;
    return constString(unwrapped, ctx);
  }
  if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression) && ts.isIdentifier(unwrapped.name)) {
    const binding = scope.bindings.get(unwrapped.expression.text);
    if (!binding || binding.kind !== 'object' || !(unwrapped.name.text in binding.fields)) reject();
    return binding.fields[unwrapped.name.text];
  }
  if (!ts.isCallExpression(unwrapped) || unwrapped.questionDotToken) reject();
  const resolved = resolveCallee(unwrapped.expression, scope, ctx);
  const returned = singleReturnExpression(resolved.declaration);
  if (!returned) reject();
  const bindings = bindArguments(resolved.declaration, [...unwrapped.arguments], scope, ctx);
  const key = `${resolved.declaration.getSourceFile().fileName}:${resolved.declaration.pos}:${JSON.stringify([...bindings])}`;
  // `active` holds the helper calls on the current evaluation path only, so a
  // helper used twice in one expression is not mistaken for recursion.
  // Distinct growing arguments (`p(x + '/')`) never repeat a key, so depth is capped as well.
  if (ctx.active.has(key) || ctx.active.size >= MAX_HELPER_DEPTH) reject();
  ctx.active.add(key);
  try {
    return fold(returned, { bindings, container: resolved.container }, ctx);
  } finally {
    ctx.active.delete(key);
  }
}

function preview(expression: ts.Expression, sourceFile: ts.SourceFile): string {
  const text = expression.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function foldRouteExpression(
  expression: ts.Expression,
  program: ts.Program,
  options: RouteEvaluationOptions = {},
): string | string[] {
  const sourceFile = bindExpressionSource(expression, program);
  try {
    return fold(expression, { bindings: new Map(), container: undefined }, {
      checker: program.getTypeChecker(),
      onInput: options.onInput,
      active: new Set(),
    });
  } catch (error) {
    if (!(error instanceof FoldRejection)) throw error;
    throw new TsToOpenApiError(diagnostic(
      sourceFile,
      expression,
      TsToOpenApiDiagnosticCode.UnsupportedRouteExpression,
      `Route path \`${preview(expression, sourceFile)}\` must be a string literal or a simple route helper.`,
    ));
  }
}
