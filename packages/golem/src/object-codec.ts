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

import { GENERATED_MODEL_SCHEMA_REF_PREFIX, MODEL_CODEC_IDS_KEY } from './schema-keywords.js';

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
export interface MaxDepthOptions {
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

export interface ObjectCodec<T = unknown> {
  readonly id: string;
  /** Model-plane JSON Schema payload. */
  readonly schema?: object;
  /** Wire-plane JSON Schema when intern ≠ model. */
  readonly wireSchema?: object;
  /** What parse checks after decoding (`Id#model-only`). */
  readonly modelOnlySchema?: object;
  /** What stringify checks after encoding (`Id#wire-only`). */
  readonly wireOnlySchema?: object;
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
  readonly schema?: object;
  readonly wireSchema?: object;
  readonly modelOnlySchema?: object;
  readonly wireOnlySchema?: object;
  /** The declared field names of a root object; `allowGetter` reads these. Another root has none, and the option has no effect. */
  readonly fields?: readonly string[];
  /** Set when the model reaches a recursive model: its input is bounded by `maxDepth` before it is converted or checked. */
  readonly recursive?: true;
  /** Schemas from a generated closed validator plan already have resolved refs. */
  readonly schemaRefsResolved?: true;
  readonly issueSource?: IssueSource;
}

const codecs = new Map<string, ObjectCodec>();
const iModelClasses = new Map<string, abstract new (values?: never) => object>();
const codecIdByConstructor = new WeakMap<Function, string>();
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
  codecIdByConstructor.set(ctor, id);
}

export function findCodecIdForConstructor(constructor: Function): string | undefined {
  return codecIdByConstructor.get(constructor);
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

export function registerObjectCodec<T>(codec: ObjectCodec<T>): void {
  codecs.set(codec.id, codec);
}

export function getObjectCodec<T = unknown>(id: string): ObjectCodec<T> | undefined {
  return codecs.get(id) as ObjectCodec<T> | undefined;
}

export function requireObjectCodec<T = unknown>(id: string): ObjectCodec<T> {
  const codec = getObjectCodec<T>(id);
  if (!codec) {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      `golem fault: the IObject codec ${JSON.stringify(id)} is not registered. `
      + `The rewrite loads the generated module that registers a codec wherever it names one, and that module did not load. Run golem generate and rewrite the file again.`,
    );
  }
  return codec;
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
export function modelValueIssues(
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

export function validationFailure(issues: readonly Issue[]): never {
  throw new LibError(LibErrorKind.Validation, 'Model validation failed.', issues);
}

export function validationUnavailable(message?: string): never {
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

export function serdeFailFast(options: SerdeOptions | ValidateOptions | undefined): boolean {
  return options?.failFast !== false;
}

/**
 * Reads a schema plane of a codec on first use. A schema refers to other codecs by id, and the codec of a model in an
 * import cycle is not registered yet when this one is.
 */
function lazySchemaPlane(schema: object, plane: ValidationPlane, resolved: boolean): () => object {
  if (resolved) return () => schema;
  let value: object | undefined;
  let resolving = false;
  return () => {
    if (value !== undefined) return value;
    // Resolving a schema reads the schema of each codec it names, which can name this one back. Only its `$id` is read then.
    if (resolving) return schema;
    resolving = true;
    try {
      value = resolveGeneratedModelSchemaRefs(schema, plane);
    } finally {
      resolving = false;
    }
    return value;
  };
}

/** Registers the codec of `id`. Its schemas resolve on first read, unless `impl.schemaRefsResolved` says they already are. */
export function createObjectCodec<T>(id: string, impl: ObjectCodecImpl<T>): ObjectCodec<T> {
  const resolved = impl.schemaRefsResolved === true;
  const planes = {
    schema: impl.schema && lazySchemaPlane(impl.schema, 'model', resolved),
    wireSchema: impl.wireSchema && lazySchemaPlane(impl.wireSchema, 'wire', resolved),
    ...(impl.modelOnlySchema ? { modelOnlySchema: lazySchemaPlane(impl.modelOnlySchema, 'model-only', resolved) } : {}),
    ...(impl.wireOnlySchema ? { wireOnlySchema: lazySchemaPlane(impl.wireOnlySchema, 'wire-only', resolved) } : {}),
  };
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
    stringify: (value, options) => impl.stringify(options?.allowGetter === true && fields !== undefined ? readRootFields(value, fields) as typeof value : value, options),
    parse: (text, options) => {
      if (bounded) rejectDeepText(text, options);
      return impl.parse(text, options);
    },
    validate: (value, options): value is T => {
      if (bounded && valueNestsDeeperThan(value, resolveMaxDepth(options?.maxDepth))) return false;
      return impl.validate(options?.allowGetter === true && fields !== undefined ? readRootFields(value, fields) : value, options);
    },
    assert: (value, options) => {
      if (bounded) rejectDeepValue(value, options);
      if (options?.allowGetter !== true || fields === undefined) return impl.assert(value, options);
      const checked = readRootFields(value, fields);
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
  Object.defineProperties(codec, Object.fromEntries(Object.entries(planes).map(([name, read]) => [
    name,
    { get: read, enumerable: true },
  ])));
  registerObjectCodec(codec);
  return codec;
}

function codecPlaneSchema(codec: ObjectCodec, plane: ValidationPlane): object | undefined {
  switch (plane) {
    case 'model': return codec.schema;
    case 'wire': return codec.wireSchema ?? codec.schema;
    case 'model-only': return codec.modelOnlySchema;
    case 'wire-only': return codec.wireOnlySchema;
  }
}

/** Public schema key that addresses one plane of this codec in a validation context. */
export function objectCodecValidationReference(codec: ObjectCodec, plane: ValidationPlane): string {
  const schema = codecPlaneSchema(codec, plane);
  if (schema !== null && typeof schema === 'object' && '$id' in schema && typeof schema.$id === 'string') return schema.$id;
  if (plane === 'model' || (plane === 'wire' && codec.wireSchema === undefined)) return codec.id;
  return `${codec.id}#${plane}`;
}

const resolvedGeneratedModelSchemas = new WeakSet<object>();

/**
 * Replace generated-model `$ref` placeholders with registered schema ids. A
 * wire schema refers to a model's wire schema when the codec has one.
 */
export function resolveGeneratedModelSchemaRefs(schema: object, plane: ValidationPlane = 'model'): object {
  if (resolvedGeneratedModelSchemas.has(schema)) return schema;
  // A residual reference names its plane (`Name#model-only`); others follow the schema's plane.
  const schemaId = (reference: string): string => {
    const hash = reference.indexOf('#');
    const name = hash < 0 ? reference : reference.slice(0, hash);
    const suffix = hash < 0 ? undefined : reference.slice(hash + 1);
    const codec = requireObjectCodec(name);
    if (suffix === 'model-only' || suffix === 'wire-only') return objectCodecValidationReference(codec, suffix);
    return objectCodecValidationReference(codec, plane === 'wire' || plane === 'wire-only' ? 'wire' : 'model');
  };
  const prefix = GENERATED_MODEL_SCHEMA_REF_PREFIX;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (key === '$ref' && typeof item === 'string' && item.startsWith(prefix)) {
        next[key] = schemaId(item.slice(prefix.length));
      } else {
        next[key] = walk(item);
      }
    }
    return next;
  };
  const resolved = walk(schema) as object;
  resolvedGeneratedModelSchemas.add(resolved);
  return resolved;
}
