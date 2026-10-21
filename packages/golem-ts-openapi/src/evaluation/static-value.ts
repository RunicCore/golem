import * as ts from '@exprtlabs/golem/ts';
import { resolveSymbol } from '@exprtlabs/golem/type-analysis';

/** A JSON-compatible value read from source without executing project code. */
export type StaticValue =
  | string
  | number
  | boolean
  | null
  | readonly StaticValue[]
  | { readonly [key: string]: StaticValue };

export type StaticValueResult =
  | { readonly ok: true; readonly value: StaticValue }
  | { readonly ok: false; readonly node: ts.Node; readonly reason: string };

/**
 * A call the caller treats as a compile-time constant, such as Nest Swagger's
 * `getSchemaPath(Model)`. Return undefined for calls it does not recognise.
 */
export type StaticIntrinsic = (call: ts.CallExpression) => StaticValueResult | undefined;

interface StaticValueOptions {
  /** Called for every declaration whose initializer contributes to the value. */
  readonly onDeclaration?: (declaration: ts.Declaration) => void;
  readonly intrinsic?: StaticIntrinsic;
}

interface EvaluationState {
  readonly checker: ts.TypeChecker;
  readonly options: StaticValueOptions;
  /** Declarations on the current evaluation path; entries are removed on return. */
  readonly active: Set<ts.Declaration>;
}

class Unresolvable {
  constructor(readonly node: ts.Node, readonly reason: string) {}
}

function fail(node: ts.Node, reason: string): never {
  throw new Unresolvable(node, reason);
}

/** Remove syntax that does not change a value: parentheses, type assertions, `!` and `satisfies`. */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Whether a file is a TypeScript standard library declaration file. */
export function isTypeScriptLibFile(fileName: string): boolean {
  const name = fileName.replace(/\\/g, '/');
  return name.includes('/typescript/lib/') || /(?:^|\/)lib\.[^/]+\.d\.ts$/.test(name);
}

/** The expression a function returns when its body is one expression or a single `return`. */
export function singleReturnExpression(declaration: ts.SignatureDeclaration): ts.Expression | undefined {
  const body = 'body' in declaration ? declaration.body : undefined;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return ts.isExpression(body) ? body : undefined;
  const statements = body.statements.filter(statement => !ts.isEmptyStatement(statement));
  const [statement] = statements;
  return statements.length === 1 && statement && ts.isReturnStatement(statement) ? statement.expression : undefined;
}

/**
 * The value symbol an expression names, with import/export aliases resolved.
 * An element access names a member only through a literal key (`E['A']`);
 * `MAP[KEY]` names no symbol because the key is itself a value.
 */
export function resolveValueSymbol(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
  const value = unwrapExpression(expression);
  if (ts.isElementAccessExpression(value)) {
    const argument = unwrapExpression(value.argumentExpression);
    if (!ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument)) return undefined;
    return resolveSymbol(checker, checker.getSymbolAtLocation(argument));
  }
  const node = ts.isPropertyAccessExpression(value) ? value.name : value;
  return resolveSymbol(checker, checker.getSymbolAtLocation(node));
}

function propertyKey(name: ts.PropertyName, state: EvaluationState): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const key = evaluate(name.expression, state);
    if (typeof key === 'string' || typeof key === 'number') return String(key);
  }
  return fail(name, 'property name is not a static string');
}

export function isStaticArray(value: StaticValue | undefined): value is readonly StaticValue[] {
  return Array.isArray(value);
}

export function isStaticRecord(value: StaticValue | undefined): value is { readonly [key: string]: StaticValue } {
  if (value === undefined) return false;
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Values of every member of an enum, across merged declarations, in declaration order. */
function enumValues(declarations: readonly ts.EnumDeclaration[], state: EvaluationState): StaticValue[] {
  return declarations.flatMap(declaration => {
    state.options.onDeclaration?.(declaration);
    return declaration.members.map(member => enumMemberValue(member, state));
  });
}

function enumMemberValue(member: ts.EnumMember, state: EvaluationState): string | number {
  state.options.onDeclaration?.(member);
  const value = state.checker.getConstantValue(member);
  if (typeof value === 'string' || typeof value === 'number') return value;
  return fail(member, `enum member ${member.name.getText()} has no constant value`);
}

function withDeclaration<T>(declaration: ts.Declaration, state: EvaluationState, read: () => T): T {
  if (state.active.has(declaration)) fail(declaration, 'value refers to itself');
  state.active.add(declaration);
  try {
    state.options.onDeclaration?.(declaration);
    return read();
  } finally {
    state.active.delete(declaration);
  }
}

/**
 * Evaluate the enum or `const` variable a resolved symbol stands for, or
 * return undefined for any other declaration. Object members are read through
 * their containing `const` value so a `let` container is never trusted.
 */
function symbolValue(symbol: ts.Symbol, reference: ts.Node, state: EvaluationState): StaticValue | undefined {
  const declarations = symbol.declarations ?? [];
  const enums = declarations.filter(ts.isEnumDeclaration);
  if (enums.length > 0) return enumValues(enums, state);
  for (const declaration of declarations) {
    if (ts.isEnumMember(declaration)) return enumMemberValue(declaration, state);
    if (ts.isVariableDeclaration(declaration)) {
      const list = declaration.parent;
      if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) {
        return fail(reference, `${symbol.getName()} is not declared with const`);
      }
      const initializer = declaration.initializer;
      if (!initializer || !ts.isIdentifier(declaration.name)) {
        return fail(reference, `${symbol.getName()} has no statically readable initializer`);
      }
      return withDeclaration(declaration, state, () => evaluate(initializer, state));
    }
  }
  return undefined;
}

function memberValue(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  state: EvaluationState,
): StaticValue {
  const symbol = resolveValueSymbol(state.checker, expression);
  const direct = symbol && symbolValue(symbol, expression, state);
  if (direct !== undefined) return direct;
  const key = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : (() => {
      const value = evaluate(expression.argumentExpression, state);
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      return fail(expression.argumentExpression, 'element key is not a static string or number');
    })();
  const target = evaluate(expression.expression, state);
  if (isStaticRecord(target) && Object.hasOwn(target, key)) return target[key];
  if (isStaticArray(target) && /^\d+$/.test(key) && Number(key) < target.length) return target[Number(key)];
  return fail(expression, `member ${key} is not a static value`);
}

function arrayValue(node: ts.ArrayLiteralExpression, state: EvaluationState): StaticValue[] {
  const values: StaticValue[] = [];
  for (const element of node.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = evaluate(element.expression, state);
      if (!isStaticArray(spread)) fail(element, 'spread value is not a static array');
      values.push(...spread);
      continue;
    }
    if (ts.isOmittedExpression(element)) fail(element, 'array holes are not static values');
    values.push(evaluate(element, state));
  }
  return values;
}

/** Define an own data property, so keys such as `__proto__` stay ordinary keys. */
function defineStaticProperty(target: Record<string, StaticValue>, key: string, value: StaticValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function objectValue(node: ts.ObjectLiteralExpression, state: EvaluationState): Record<string, StaticValue> {
  const value: Record<string, StaticValue> = {};
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = evaluate(property.expression, state);
      if (!isStaticRecord(spread)) fail(property, 'spread value is not a static object');
      for (const [key, item] of Object.entries(spread)) defineStaticProperty(value, key, item);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      defineStaticProperty(value, propertyKey(property.name, state), evaluate(property.initializer, state));
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      defineStaticProperty(value, property.name.text, evaluate(property.name, state));
      continue;
    }
    fail(property, 'object members must be static property assignments');
  }
  return value;
}

function evaluate(expression: ts.Expression, state: EvaluationState): StaticValue {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node)
    && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = evaluate(node.operand, state);
    if (typeof operand !== 'number') fail(node, 'unary sign requires a static number');
    return node.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += concatenable(span.expression, state);
      text += span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left, state);
    const right = evaluate(node.right, state);
    if (typeof left === 'number' && typeof right === 'number') return left + right;
    if ((typeof left === 'string' || typeof left === 'number') && (typeof right === 'string' || typeof right === 'number')) {
      return `${left}${right}`;
    }
    return fail(node, '`+` requires static strings or numbers');
  }
  if (ts.isCallExpression(node)) {
    const result = state.options.intrinsic?.(node);
    if (!result) return fail(node, 'calls are evaluated at runtime');
    if (!result.ok) return fail(result.node, result.reason);
    return result.value;
  }
  if (ts.isArrayLiteralExpression(node)) return arrayValue(node, state);
  if (ts.isObjectLiteralExpression(node)) return objectValue(node, state);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return memberValue(node, state);
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') fail(node, 'undefined is not a JSON value');
    const symbol = resolveValueSymbol(state.checker, node);
    if (!symbol) fail(node, `${node.text} does not resolve to a declaration`);
    const value = symbolValue(symbol, node, state);
    if (value === undefined) fail(node, `${node.text} is not a const value, enum, or enum member`);
    return value;
  }
  return fail(node, 'expression is not a literal, const value, or enum');
}

function concatenable(expression: ts.Expression, state: EvaluationState): string {
  const value = evaluate(expression, state);
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return fail(expression, 'template spans must be static strings or numbers');
}

/**
 * Read a JSON-compatible value from source with the type checker: literals,
 * arrays, objects, `as`/`satisfies`/`!`/parentheses, `const` identifiers,
 * const-object members, enum members, and whole enums (as their value
 * arrays), and template or `+` string concatenation. `let`/`var` bindings,
 * calls other than `options.intrinsic` ones and other runtime expressions are
 * reported as unresolvable instead of being guessed.
 */
export function evaluateStaticValue(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  options: StaticValueOptions = {},
): StaticValueResult {
  try {
    return { ok: true, value: evaluate(expression, { checker, options, active: new Set() }) };
  } catch (error) {
    if (error instanceof Unresolvable) return { ok: false, node: error.node, reason: error.reason };
    throw error;
  }
}
