/**
 * Runtime IObject registry. Generated stringify/parse/validate bind here so
 * the build-time rewrite can turn `stringify<T>` into `requireObjectCodec(id).stringify`.
 */

import {
  IssueRepresentation,
  IssueSource,
  LibError,
  LibErrorKind,
  toIssue,
  type Issue,
} from './errors.js';
import { nestingDepthError, readRootFields, resolveMaxDepth, textNestsDeeperThan, valueNestsDeeperThan } from './conversion.js';
import { withoutInstanceState } from './presence.js';
import type { SchemaIssue } from './issue-messages.js';
import type { ModelValidationContext, WireFormat } from './model.js';
import type { Validator } from './validation-runtime.js';

import { MODEL_CODEC_IDS_KEY } from './schema-keywords.js';
import { linkConstructorToCodec, registerObjectCodec } from './codec-registry.js';

export { findCodecIdForConstructor, getObjectCodec, registerObjectCodec, requireObjectCodec } from './codec-registry.js';

/** The error a generic serde call throws when no build has rewritten its type argument. */
export function untransformedCallError(name: string): LibError {
  return new LibError(
    LibErrorKind.ValidationUnavailable,
    `${name}<T> was not rewritten to a generated function. Build with \`golem build\`, the golem Vite or esbuild plugin, or Node with \`--import @exprtlabs/golem/register\`; a package installed in \`node_modules\` is not rewritten.`,
  );
}

/**
 * The nesting bound of a call on a recursive model: how many levels of objects and arrays its input may nest, 512
 * by default. `Infinity` turns the bound off. A model that reaches no recursive model has no bound.
 */
interface MaxDepthOptions {
  readonly maxDepth?: number;
}

export interface ValidateOptions extends MaxDepthOptions {
  readonly failFast?: boolean;
  readonly validationContext?: ModelValidationContext;
}

/** The option of one `stringify`, `toWireFormat`, `validate` or `assert` call. Decode does not take it. */
export interface AllowGetterOptions {
  /**
   * Counts a declared field of the root value when a getter or an inherited value supplies it. The default reads own
   * enumerable properties only, as `JSON.stringify` does. Nested values are judged without it.
   */
  readonly allowGetter?: boolean;
}

export interface SerdeOptions extends MaxDepthOptions {
  readonly validate?: boolean;
  readonly failFast?: boolean;
  readonly validationContext?: ModelValidationContext;
  /** Set by golem's rewrite for `parse<Class>` / `fromWireFormat<Class>`. */
  readonly construct?: abstract new (values?: never) => object;
}

/** What a query string can carry for one field: the scalar types it admits, its literals, and the shape of an array item. */
export interface QueryFieldShape {
  readonly types: readonly ('string' | 'number' | 'integer' | 'boolean')[];
  readonly literals?: readonly (string | number | boolean)[];
  readonly item?: QueryFieldShape;
}

/** The fields of a model that a query string decodes, by name. */
export type QueryFieldTable = Readonly<Record<string, QueryFieldShape>>;

export interface ObjectCodec<T = unknown> {
  readonly id: string;
  /** The query fields `NestModelInterceptor` decodes from strings; absent when no field needs it. */
  readonly queryFields?: QueryFieldTable;
  /** Origin of generated issues; TypeScript IObject/IModel vs OpenAPI SDK. */
  readonly issueSource?: IssueSource;
  stringify(value: T, options?: SerdeOptions & AllowGetterOptions): string;
  parse(text: string, options?: SerdeOptions): T;
  validate(value: unknown, options?: ValidateOptions & AllowGetterOptions): value is T;
  assert(value: unknown, options?: ValidateOptions & AllowGetterOptions): T;
  /** Returns the wire type of the argument; a registry codec (`T = unknown`) still types a model argument. */
  toWireFormat<Value extends T>(value: Value, options?: SerdeOptions & AllowGetterOptions): WireFormat<Value>;
  fromWireFormat(wire: unknown, options?: SerdeOptions): T;
}

export interface ObjectCodecImpl<T = unknown> {
  stringify(value: T, options?: SerdeOptions): string;
  parse(text: string, options?: SerdeOptions): T;
  validate(value: unknown, options?: ValidateOptions): boolean;
  assert(value: unknown, options?: ValidateOptions): T;
  toWireFormat(value: T, options?: SerdeOptions): unknown;
  fromWireFormat(wire: unknown, options?: SerdeOptions): T;
  readonly queryFields?: QueryFieldTable;
  /** The declared field names of a root object; `allowGetter` reads these. Another root has none, and the option has no effect. */
  readonly fields?: readonly string[];
  /** Set when the model reaches a recursive model: its input is bounded by `maxDepth` before it is converted or checked. */
  readonly recursive?: true;
  readonly issueSource?: IssueSource;
}

const iModelClasses = new Map<string, abstract new (values?: never) => object>();
/** A codec schema plane; the validation reference names it (`Id`, `Id#wire`, `Id#model-only`, `Id#wire-only`). */
export type ValidationPlane = 'model' | 'wire' | 'model-only' | 'wire-only';
interface ContextValidatorCache {
  readonly first: Map<string, Validator>;
  readonly all: Map<string, Validator>;
}
const contextValidators = new WeakMap<ModelValidationContext, ContextValidatorCache>();

/** Resolve only within an explicit environment; this function never uses the global fallback. */
export function resolveModelValidationContextValidator(
  context: ModelValidationContext,
  reference: string,
  mode: 'first' | 'all',
): Validator {
  if (context === null || typeof context !== 'object') {
    throw new LibError(LibErrorKind.ValidationUnavailable, 'A model validation context must be an object.');
  }
  let cache = contextValidators.get(context);
  if (!cache) {
    cache = { first: new Map(), all: new Map() };
    contextValidators.set(context, cache);
  }
  const validators = mode === 'first' ? cache.first : cache.all;
  const cached = validators.get(reference);
  if (cached) return cached;

  const resolved: unknown = typeof context.resolve === 'function' ? context.resolve(reference, mode) : undefined;
  if (typeof resolved !== 'function') {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      `The model validation context has no validator for schema ${JSON.stringify(reference)} (${mode}).`,
    );
  }
  const validator = resolved as Validator;
  validators.set(reference, validator);
  return validator;
}

/**
 * Codec ids registered for a model class, as a non-enumerable own property of
 * its prototype. Validation reads it without a registry import, so generated
 * validators need no import of this module. The compiler emits the same key.
 */
const MODEL_CODEC_IDS = Symbol.for(MODEL_CODEC_IDS_KEY);

function markModelCodecId(ctor: abstract new (values?: never) => object, name: string): void {
  const prototype: object = ctor.prototype;
  const ids: readonly string[] = Object.hasOwn(prototype, MODEL_CODEC_IDS) ? Reflect.get(prototype, MODEL_CODEC_IDS) : [];
  if (ids.includes(name)) return;
  Object.defineProperty(prototype, MODEL_CODEC_IDS, { value: Object.freeze([...ids, name]), configurable: true });
}

export function registerIModelClass(name: string, ctor: abstract new (values?: never) => object): void {
  iModelClasses.set(name, ctor);
  // `<codec id>#<class>` names one of several classes linked to a model; the model has no default class.
  const variant = name.indexOf('#');
  const id = variant > 0 ? name.slice(0, variant) : name;
  markModelCodecId(ctor, id);
  linkConstructorToCodec(ctor, id);
}

export function getIModelClass(id: string): (abstract new (values?: never) => object) | undefined {
  return iModelClasses.get(id);
}

export function requireIModelClass(id: string): abstract new (values?: never) => object {
  const ctor = getIModelClass(id);
  if (!ctor) {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      `IModel class ${JSON.stringify(id)} is not registered.`,
    );
  }
  return ctor;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const message = 'The input is not valid JSON.';
    throw new LibError(
      LibErrorKind.InvalidJson,
      message,
      [{
        code: 'invalid_json',
        message,
        path: [],
        source: IssueSource.JSON,
        representation: IssueRepresentation.Wire,
      }],
      { cause },
    );
  }
}

/**
 * Quote a string as a JSON token. Clean ASCII/BMP skips `JSON.stringify`;
 * quotes, escapes, controls, surrogates, and JS line separators use it.
 */
export function stringifyJsonString(value: string): string {
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    const point = value.charCodeAt(index);
    if (
      point < 32
      || point === 0x22
      || point === 0x5c
      || (point >= 0xd800 && point <= 0xdfff)
      || point === 0x2028
      || point === 0x2029
    ) {
      return JSON.stringify(value);
    }
  }
  return `"${value}"`;
}

export function stringifyJsonNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new LibError(LibErrorKind.Serialization, 'JSON numbers must be finite.');
  }
  return value;
}

export function stringifyJsonBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

export function stringifyJsonScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(stringifyJsonNumber(value));
  if (typeof value === 'string') return stringifyJsonString(value);
  const data = withoutInstanceState(value);
  const encoded = JSON.stringify(data);
  return encoded === undefined ? 'null' : encoded;
}

export function stringifyJsonArray<T>(
  elements: ArrayLike<T | undefined>,
  write: (element: T, index: number) => string | number,
): string {
  const length = Math.min(Math.max(Math.trunc(elements.length) || 0, 0), Number.MAX_SAFE_INTEGER);
  let out = '[';
  for (let index = 0; index < length; index += 1) {
    if (index !== 0) out += ',';
    const element = elements[index];
    out += element === undefined ? 'null' : write(element, index);
  }
  return `${out}]`;
}

/**
 * Rethrows a LibError as it is; wraps anything else in the Validation error of a check that could not finish.
 * A TValidation function that throws, or returns neither boolean nor string, is the application's fault, not the input's.
 */
export function validationUnfinished(error: unknown): never {
  if (error instanceof LibError) throw error;
  throw new LibError(LibErrorKind.Validation, 'Model validation could not finish.', [], { cause: error, causedByInput: false });
}

/** What a validator reports for `value`: the context's validator when the options name one, else the generated one. */
function runModelValidator(
  value: unknown,
  options: ValidateOptions | undefined,
  validator: Validator,
  reference: string,
): readonly SchemaIssue[] {
  const all = options?.failFast === false;
  const run = options?.validationContext === undefined
    ? validator
    : resolveModelValidationContextValidator(options.validationContext, reference, all ? 'all' : 'first');
  let issues: unknown;
  try {
    issues = run(value, all);
  } catch (error) {
    validationUnfinished(error);
  }
  if (Array.isArray(issues)) return issues as readonly SchemaIssue[];
  if (issues !== null && typeof issues === 'object' && typeof Reflect.get(issues, 'then') === 'function') {
    // A synchronous API cannot await this result, but consuming it keeps a rejected override from becoming an unhandled rejection.
    void Promise.resolve(issues).catch(() => undefined);
    throw new LibError(LibErrorKind.ValidationUnavailable, 'Synchronous model validation cannot use an asynchronous validator.');
  }
  throw new TypeError('A validator must return an array of issues.');
}

/** Whether `value` passes the validator, or the context's validator for `reference`. */
export function isValidModelValue(
  value: unknown,
  options: ValidateOptions | undefined,
  validator: Validator,
  reference: string,
): boolean {
  return runModelValidator(value, options, validator, reference).length === 0;
}

/** The public issues of `value`: from the first failure, or from every failure with `failFast: false`. */
function modelValueIssues(
  value: unknown,
  options: ValidateOptions | undefined,
  validator: Validator,
  reference: string,
  representation: IssueRepresentation,
  source: IssueSource,
): readonly Issue[] {
  // A rule of a TValidation function is the application's, whatever generated the validator.
  return runModelValidator(value, options, validator, reference)
    .map((issue) => toIssue(issue, issue.code === 'custom' ? IssueSource.Custom : source, representation));
}

/** The body of a generated assert function: throws the validation error when the value fails. */
export function assertModelValue(
  value: unknown,
  options: ValidateOptions | undefined,
  validator: Validator,
  reference: string,
  representation: IssueRepresentation,
  source: IssueSource,
): void {
  const issues = modelValueIssues(value, options, validator, reference, representation, source);
  if (issues.length > 0) validationFailure(issues);
}

function validationFailure(issues: readonly Issue[]): never {
  throw new LibError(LibErrorKind.Validation, 'Model validation failed.', issues);
}

function validationUnavailable(message?: string): never {
  throw new LibError(
    LibErrorKind.ValidationUnavailable,
    message ?? 'Validation is not generated for this profile.',
  );
}

/** Validation on when the golem profile enabled it; `{ validate: false }` skips. */
export function serdeValidates(options: SerdeOptions | undefined, validationEnabled: boolean): boolean {
  if (!validationEnabled) {
    if (options?.validate === true) validationUnavailable();
    return false;
  }
  return options?.validate !== false;
}

/**
 * The `validate<Id>` and `assert<Id>` of a model generated with validation off. Each model's file types the one stub as
 * its own function, so the file holds no body for it.
 */
export function validationUnavailableStub(value: unknown, options?: ValidateOptions): value is never;
export function validationUnavailableStub(value: unknown, options?: ValidateOptions): never;
export function validationUnavailableStub(): never {
  return validationUnavailable();
}

/** Registers the codec of `id`. */
export function createObjectCodec<T>(id: string, impl: ObjectCodecImpl<T>): ObjectCodec<T> {
  const fields = impl.fields;
  const bounded = impl.recursive === true;
  // Input to a recursive model is walked once, without recursion, before the generated code recurses over it. The walk
  // reads the text of `parse` without parsing it. `validate` answers false for input it will not walk.
  const rejectDeepText = (text: string, options: MaxDepthOptions | undefined): void => {
    const limit = resolveMaxDepth(options?.maxDepth);
    if (typeof text === 'string' && textNestsDeeperThan(text, limit)) throw nestingDepthError(limit);
  };
  const rejectDeepValue = (value: unknown, options: MaxDepthOptions | undefined): void => {
    const limit = resolveMaxDepth(options?.maxDepth);
    if (valueNestsDeeperThan(value, limit)) throw nestingDepthError(limit);
  };
  // Without `allowGetter` the value is the root as it is: the check is written in each call, so no function call and no copy.
  const codec: ObjectCodec<T> = {
    id,
    issueSource: impl.issueSource,
    ...(impl.queryFields ? { queryFields: impl.queryFields } : {}),
    stringify: (value, options) => impl.stringify(options?.allowGetter === true && fields !== undefined ? readRootFields(value, fields) as typeof value : value, options),
    parse: (text, options) => {
      if (bounded) rejectDeepText(text, options);
      return impl.parse(text, options);
    },
    // The bound judges the root the implementation reads, so nesting that a root getter supplies counts with `allowGetter`.
    validate: (value, options): value is T => {
      const checked = options?.allowGetter === true && fields !== undefined ? readRootFields(value, fields) : value;
      if (bounded && valueNestsDeeperThan(checked, resolveMaxDepth(options?.maxDepth))) return false;
      return impl.validate(checked, options);
    },
    assert: (value, options) => {
      if (options?.allowGetter !== true || fields === undefined) {
        if (bounded) rejectDeepValue(value, options);
        return impl.assert(value, options);
      }
      const checked = readRootFields(value, fields);
      if (bounded) rejectDeepValue(checked, options);
      const result = impl.assert(checked, options);
      return checked === value ? result : value as T;
    },
    // The generated implementation returns the emitted JSON type, which WireFormat mirrors.
    toWireFormat: <Value extends T>(value: Value, options?: SerdeOptions & AllowGetterOptions) => impl.toWireFormat(options?.allowGetter === true && fields !== undefined ? readRootFields(value, fields) as Value : value, options) as WireFormat<Value>,
    fromWireFormat: (wire, options) => {
      if (bounded) rejectDeepValue(wire, options);
      return impl.fromWireFormat(wire, options);
    },
  };
  registerObjectCodec(codec);
  return codec;
}

/** Public schema key that addresses one plane of this codec in a validation context: the codec id, then `#plane` for a residual or wire plane. */
export function objectCodecValidationReference(codec: ObjectCodec, plane: ValidationPlane): string {
  return plane === 'model' ? codec.id : `${codec.id}#${plane}`;
}
