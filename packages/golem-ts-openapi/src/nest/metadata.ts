import * as ts from '@exprtlabs/golem/ts';
import {
  CodegenDiagnosticSeverity,
  TsToOpenApiDiagnosticCode,
  TsToOpenApiError,
  diagnostic,
  type TsToOpenApiDiagnostic,
} from '../diagnostics.js';
import {
  evaluateStaticValue,
  isStaticArray,
  isStaticRecord,
  resolveValueSymbol,
  unwrapExpression,
  type StaticIntrinsic,
  type StaticValue,
  type StaticValueResult,
} from '../evaluation/static-value.js';
import { hasAnyDecorator, hasDecorator } from './analysis-utils.js';
import { NEST_SWAGGER, callArguments, decoratorsOf, nestPackageOf } from './symbols.js';
import type { DecoratorInfo, TypeReference } from './types.js';

/** What decorator metadata reading needs: the checker plus optional component and warning sinks. */
export interface MetadataReader {
  readonly checker: ts.TypeChecker;
  readonly registerSchemaComponent?: (name: string, reference: TypeReference) => void;
  readonly onWarning?: (warning: TsToOpenApiDiagnostic) => void;
}

const SCHEMA_PREFIX = '#/components/schemas/';

/** The component name Nest Swagger gives a class: its `@ApiSchema({ name })`, else the class name. */
function schemaComponentName(reader: MetadataReader, symbol: ts.Symbol): string {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isClassDeclaration(declaration)) continue;
    const apiSchema = hasDecorator(decoratorsOf(reader.checker, declaration), 'ApiSchema', NEST_SWAGGER);
    const name = apiSchema && decoratorOptions(reader, apiSchema).string('name');
    if (name) return name;
  }
  return symbol.getName();
}

/**
 * `getSchemaPath(Model)` and `refs(...Models)` from `@nestjs/swagger` are
 * pure name lookups; evaluate them to the `$ref` Nest would produce and
 * register the class so its component schema is emitted.
 */
function swaggerIntrinsics(reader: MetadataReader): StaticIntrinsic {
  const { checker } = reader;
  const schemaPath = (argument: ts.Expression | undefined, call: ts.CallExpression): StaticValueResult => {
    if (!argument) return { ok: false, node: call, reason: 'getSchemaPath() requires a model class' };
    const value = unwrapExpression(argument);
    if (ts.isStringLiteralLike(value)) return { ok: true, value: value.text.startsWith(SCHEMA_PREFIX) ? value.text : `${SCHEMA_PREFIX}${value.text}` };
    const symbol = resolveValueSymbol(checker, value);
    if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0) {
      return { ok: false, node: argument, reason: 'getSchemaPath() and refs() require a class or a schema name literal' };
    }
    const name = schemaComponentName(reader, symbol);
    reader.registerSchemaComponent?.(name, {
      type: checker.getDeclaredTypeOfSymbol(symbol),
      ...(symbol.declarations?.[0] ? { declaration: symbol.declarations[0] } : {}),
      sourceNode: argument,
      sourceFile: argument.getSourceFile(),
    });
    return { ok: true, value: `${SCHEMA_PREFIX}${name}` };
  };
  return call => {
    if (nestPackageOf(checker, call.expression) !== NEST_SWAGGER) return undefined;
    const name = resolveValueSymbol(checker, call.expression)?.getName();
    if (name === 'getSchemaPath') return schemaPath(call.arguments[0], call);
    if (name !== 'refs') return undefined;
    const references: StaticValue[] = [];
    for (const argument of call.arguments) {
      const path = schemaPath(argument, call);
      if (!path.ok) return path;
      references.push({ $ref: path.value });
    }
    return { ok: true, value: references };
  };
}

function evaluate(reader: MetadataReader, expression: ts.Expression): StaticValueResult {
  return evaluateStaticValue(reader.checker, expression, { intrinsic: swaggerIntrinsics(reader) });
}

function metadataError(node: ts.Node, code: TsToOpenApiDiagnosticCode, message: string): never {
  throw new TsToOpenApiError(diagnostic(node.getSourceFile(), node, code, message));
}

/**
 * Read decorator metadata as a JSON value with the type checker. An absent
 * expression is undefined; anything present must be a compile-time constant
 * (see `evaluateStaticValue`) or generation stops with a located diagnostic.
 */
function readStatic(
  reader: MetadataReader,
  expression: ts.Expression | undefined,
  label: string,
  code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
): StaticValue | undefined {
  if (!expression) return undefined;
  const result = evaluate(reader, expression);
  if (result.ok) return result.value;
  return metadataError(result.node, code, `${label} must be a compile-time constant: ${result.reason}.`);
}

/** Narrow a read value; `node` locates the diagnostic when the value has another type. */
function expect<T extends StaticValue>(
  value: StaticValue | undefined,
  accept: (item: StaticValue) => item is T,
  node: ts.Node,
  label: string,
  expected: string,
  code: TsToOpenApiDiagnosticCode,
): T | undefined {
  if (value === undefined || accept(value)) return value;
  return metadataError(node, code, `${label} must be ${expected}.`);
}

const isString = (value: StaticValue): value is string => typeof value === 'string';
const isNumber = (value: StaticValue): value is number => typeof value === 'number';
const isBoolean = (value: StaticValue): value is boolean => typeof value === 'boolean';
const isRecord = (value: StaticValue): value is { readonly [key: string]: StaticValue } => isStaticRecord(value);
const isStringList = (value: StaticValue): value is readonly string[] => isStaticArray(value) && value.every(isString);

export function readString(reader: MetadataReader, expression: ts.Expression | undefined, label: string, code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata): string | undefined {
  return expression && expect(readStatic(reader, expression, label, code), isString, expression, label, 'a string', code);
}

export function readNumber(reader: MetadataReader, expression: ts.Expression | undefined, label: string, code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata): number | undefined {
  return expression && expect(readStatic(reader, expression, label, code), isNumber, expression, label, 'a number', code);
}

export function readBoolean(reader: MetadataReader, expression: ts.Expression | undefined, label: string, code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata): boolean | undefined {
  return expression && expect(readStatic(reader, expression, label, code), isBoolean, expression, label, 'a boolean', code);
}

/** A string or an array of strings, as accepted by `@ApiTags`, `@ApiProduces` and security scopes. */
function readStringList(reader: MetadataReader, expression: ts.Expression | undefined, label: string): readonly string[] | undefined {
  if (!expression) return undefined;
  const value = readStatic(reader, expression, label);
  return typeof value === 'string'
    ? [value]
    : expect(value, isStringList, expression, label, 'a string or an array of strings', TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata);
}

type OptionEntry =
  | { readonly kind: 'inline'; readonly expression: ts.Expression }
  | { readonly kind: 'value'; readonly value: StaticValue; readonly node: ts.Node };

/**
 * The options object of a decorator. Inline properties keep their expression,
 * so `type: () => Model` thunks stay readable; spreads and a `const` options
 * argument are evaluated as static values, later keys overriding earlier ones.
 */
export class DecoratorOptions {
  constructor(
    private readonly reader: MetadataReader,
    private readonly label: string,
    private readonly entries: ReadonlyMap<string, OptionEntry>,
  ) {}

  private optionLabel(name: string): string {
    return `${this.label}({ ${name} })`;
  }

  /** The source node supplying a key: its inline expression, or the spread/constant it came from. */
  node(name: string): ts.Node | undefined {
    const entry = this.entries.get(name);
    return entry && (entry.kind === 'value' ? entry.node : entry.expression);
  }

  /** The inline expression for a key that must be read as syntax, such as a `type` thunk. */
  expression(name: string): ts.Expression | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    if (entry.kind === 'inline') return entry.expression;
    return metadataError(entry.node, TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata, `${this.optionLabel(name)} must be written inline in the decorator, not supplied through a spread or constant.`);
  }

  /** The static value of a key, or of a string `type` supplied by a spread or constant. */
  entry(name: string): OptionEntry | undefined {
    return this.entries.get(name);
  }

  value(name: string, code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata): StaticValue | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return entry.kind === 'value' ? entry.value : readStatic(this.reader, entry.expression, this.optionLabel(name), code);
  }

  private typed<T extends StaticValue>(
    name: string,
    accept: (item: StaticValue) => item is T,
    expected: string,
    code: TsToOpenApiDiagnosticCode,
  ): T | undefined {
    const node = this.node(name);
    return node && expect(this.value(name, code), accept, node, this.optionLabel(name), expected, code);
  }

  string(name: string, code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata): string | undefined {
    return this.typed(name, isString, 'a string', code);
  }

  number(name: string, code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata): number | undefined {
    return this.typed(name, isNumber, 'a number', code);
  }

  boolean(name: string, code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata): boolean | undefined {
    return this.typed(name, isBoolean, 'a boolean', code);
  }

  record(name: string, code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata): Readonly<Record<string, StaticValue>> | undefined {
    return this.typed(name, isRecord, 'an object', code);
  }

  /**
   * A documentation-only key (description, summary, title, examples,
   * externalDocs). A value computed at runtime, such as `t('key')` or
   * `new Date()`, is omitted with a warning because it cannot change the
   * wire contract.
   */
  documentation(name: string): StaticValue | undefined {
    const entry = this.entries.get(name);
    if (!entry || entry.kind === 'value') return entry?.value;
    const result = evaluate(this.reader, entry.expression);
    if (result.ok) return result.value;
    const warning = diagnostic(
      result.node.getSourceFile(),
      result.node,
      TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
      `${this.optionLabel(name)} is not a compile-time constant (${result.reason}); it is omitted from the document.`,
      CodegenDiagnosticSeverity.Warning,
    );
    if (!this.reader.onWarning) throw new TsToOpenApiError(warning);
    this.reader.onWarning(warning);
    return undefined;
  }

  documentationString(name: string): string | undefined {
    const value = this.documentation(name);
    if (value === undefined || typeof value === 'string') return value;
    return metadataError(this.node(name)!, TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata, `${this.optionLabel(name)} must be a string.`);
  }
}

function inlineKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** Read an options object argument; `code` classifies a non-object argument. */
function objectOptions(
  reader: MetadataReader,
  argument: ts.Expression | undefined,
  label: string,
  code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
): DecoratorOptions {
  const entries = new Map<string, OptionEntry>();
  const setValues = (value: StaticValue | undefined, node: ts.Node): void => {
    if (!isStaticRecord(value)) metadataError(node, code, `${label}() options must be a static object.`);
    for (const [key, item] of Object.entries(value)) {
      entries.delete(key);
      entries.set(key, { kind: 'value', value: item, node });
    }
  };
  const value = argument && unwrapExpression(argument);
  if (value && ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        setValues(readStatic(reader, property.expression, `${label}() options spread`, code), property);
        continue;
      }
      const key = (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) ? inlineKey(property.name) : undefined;
      if (key === undefined) metadataError(property, code, `${label}() options must use static property names.`);
      const expression = ts.isPropertyAssignment(property) ? property.initializer : (property as ts.ShorthandPropertyAssignment).name as ts.Expression;
      entries.delete(key);
      entries.set(key, { kind: 'inline', expression });
    }
  } else if (argument) {
    setValues(readStatic(reader, argument, `${label}() options`, code), argument);
  }
  return new DecoratorOptions(reader, label, entries);
}

/** The options object passed as a decorator's argument (the first by default). */
export function decoratorOptions(
  reader: MetadataReader,
  info: DecoratorInfo,
  index = 0,
  code = TsToOpenApiDiagnosticCode.UnsupportedSchemaMetadata,
): DecoratorOptions {
  return objectOptions(reader, callArguments(info)[index], `@${info.name ?? 'decorator'}`, code);
}

export function parseTags(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
): readonly string[] {
  const tags: string[] = [];
  for (const decorator of hasAnyDecorator(decorators, ['ApiTags'], NEST_SWAGGER)) {
    for (const argument of callArguments(decorator)) {
      tags.push(...readStringList(reader, argument, '@ApiTags()') ?? []);
    }
  }
  return [...new Set(tags)];
}

export function callStringValues(reader: MetadataReader, info: DecoratorInfo): readonly string[] {
  return callArguments(info).flatMap(argument => readStringList(reader, argument, `@${info.name ?? 'decorator'}()`) ?? []);
}

const SECURITY_DEFAULT_NAMES: Readonly<Record<string, string>> = {
  ApiBearerAuth: 'bearer',
  ApiBasicAuth: 'basic',
  ApiKeyAuth: 'apiKey',
  ApiCookieAuth: 'cookie',
};

export function parseSecurity(
  reader: MetadataReader,
  decorators: readonly DecoratorInfo[],
): readonly Record<string, string[]>[] | undefined {
  const values: Record<string, string[]>[] = [];
  for (const decorator of decorators) {
    if (decorator.packageName !== NEST_SWAGGER || decorator.name === undefined) continue;
    const label = `@${decorator.name}()`;
    const arguments_ = callArguments(decorator);
    const defaultName = SECURITY_DEFAULT_NAMES[decorator.name];
    if (defaultName !== undefined) {
      values.push({ [readString(reader, arguments_[0], label) ?? defaultName]: [] });
    } else if (decorator.name === 'ApiOAuth2') {
      const scopes = readStringList(reader, arguments_[0], label) ?? [];
      const name = readString(reader, arguments_[1], label) ?? 'oauth2';
      values.push({ [name]: [...scopes] });
    } else if (decorator.name === 'ApiSecurity') {
      const requirement = readStatic(reader, arguments_[0], label);
      if (typeof requirement === 'string') {
        values.push({ [requirement]: [...readStringList(reader, arguments_[1], label) ?? []] });
        continue;
      }
      const node = arguments_[0] ?? decorator.decorator;
      if (!isStaticRecord(requirement)) {
        metadataError(node, TsToOpenApiDiagnosticCode.InvalidSecurityRequirement, `${label} requires a scheme name or a record of scheme scopes.`);
      }
      const normalized: Record<string, string[]> = {};
      for (const [scheme, scopes] of Object.entries(requirement)) {
        if (!isStaticArray(scopes) || !isStringList(scopes)) {
          metadataError(node, TsToOpenApiDiagnosticCode.InvalidSecurityRequirement, `${label} scopes for ${scheme} must be an array of strings.`);
        }
        normalized[scheme] = [...scopes];
      }
      values.push(normalized);
    }
  }
  return values.length > 0 ? values : undefined;
}
