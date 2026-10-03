/**
 * Runtime IObject registry. Generated stringify/parse/validate bind here so
 * the build-time rewrite can turn `stringify<T>` into `requireObjectCodec(id).stringify`.
 */

import {
  IssueCode,
  IssueRepresentation,
  IssueSource,
  LibError,
  LibErrorKind,
  type Issue,
} from './errors.js';
import { issuesFromErrors } from './validation-issues.js';
import type { ModelRuntimeSyncValidator, ModelRuntimeValidator, ModelValidationContext, WireFormat } from './model.js';

import { GENERATED_MODEL_SCHEMA_REF_PREFIX } from './schema-keywords.js';

/** The error a generic serde call throws when no build has rewritten its type argument. */
export function untransformedCallError(name: string): LibError {
  return new LibError(
    LibErrorKind.ValidationUnavailable,
    `${name}<T> was not rewritten to a generated function. Run \`golem generate\`, then build with \`golem build\`, the golem Vite or esbuild plugin, or run Node with \`--import @exprtlabs/golem/register\`.`,
  );
}

export interface ValidateOptions {
  readonly failFast?: boolean;
  readonly validationContext?: ModelValidationContext;
}

export interface SerdeOptions {
  readonly validate?: boolean;
  readonly failFast?: boolean;
  readonly validationContext?: ModelValidationContext;
  /** Set by golem's rewrite for `parse<Class>` / `fromWireFormat<Class>`. */
  readonly construct?: abstract new (values?: never) => object;
}

export interface ObjectCodec<T = unknown> {
  readonly id: string;
  /** Model-plane JSON Schema payload; reused by parent Ajv `$ref` graphs. */
  readonly schema?: object;
  /** Wire-plane JSON Schema when intern ≠ model. */
  readonly wireSchema?: object;
  /** What parse checks after decoding (`Id#model-only`). */
  readonly modelOnlySchema?: object;
  /** What stringify checks after encoding (`Id#wire-only`). */
  readonly wireOnlySchema?: object;
  /** Origin of generated Ajv issues; TypeScript IObject/IModel vs OpenAPI SDK. */
  readonly issueSource?: IssueSource;
  /** Ajv errors from the last `validate` call. */
  readonly errors?: readonly unknown[] | null;
  stringify(value: T, options?: SerdeOptions): string;
  parse(text: string, options?: SerdeOptions): T;
  validate(value: unknown, options?: ValidateOptions): value is T;
  assert(value: unknown, options?: ValidateOptions): T;
  /** Returns the wire type of the argument; a registry codec (`T = unknown`) still types a model argument. */
  toWireFormat<Value extends T>(value: Value, options?: SerdeOptions): WireFormat<Value>;
  fromWireFormat(wire: unknown, options?: SerdeOptions): T;
}

export interface ObjectCodecImpl<T = unknown> {
  stringify(value: T, options?: SerdeOptions): string;
  parse(text: string, options?: SerdeOptions): T;
  readonly validate: {
    (value: unknown, options?: ValidateOptions): boolean;
    readonly errors?: readonly unknown[] | null;
  };
  assert(value: unknown, options?: ValidateOptions): T;
  toWireFormat(value: T, options?: SerdeOptions): unknown;
  fromWireFormat(wire: unknown, options?: SerdeOptions): T;
  readonly schema?: object;
  readonly wireSchema?: object;
  readonly modelOnlySchema?: object;
  readonly wireOnlySchema?: object;
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
  readonly first: Map<string, ModelRuntimeValidator>;
  readonly all: Map<string, ModelRuntimeValidator>;
}
const contextValidators = new WeakMap<ModelValidationContext, ContextValidatorCache>();
const HASHED_CODEC_SUFFIX = /^[0-9a-f]{8}$/;

/** Resolve only within an explicit environment; this function never uses the global fallback. */
export function resolveModelValidationContextValidator(
  context: ModelValidationContext,
  reference: string,
  mode: 'first' | 'all',
): ModelRuntimeValidator {
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

  const resolved = typeof context.resolve === 'function'
    ? context.resolve(reference, mode)
    : context.engine?.getSchema(reference);
  if (typeof resolved !== 'function') {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      `The model validation context has no validator for schema ${JSON.stringify(reference)} (${mode}).`,
    );
  }
  validators.set(reference, resolved);
  return resolved;
}

/** Synchronous generated APIs must reject asynchronous context overrides clearly. */
export function runSynchronousValidation(validator: ModelRuntimeValidator, value: unknown): boolean {
  const result: unknown = validator(value);
  if (typeof result === 'boolean') return result;
  if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
    let then: unknown;
    try { then = Reflect.get(result, 'then'); }
    catch (cause) {
      throw new LibError(LibErrorKind.Validation, 'A validation result could not be inspected.', [], { cause, causedByInput: false });
    }
    if (typeof then === 'function') {
      // A sync API cannot await this result, but consume it so rejected async
      // overrides do not become unhandled rejections after this call throws.
      void Promise.resolve(result).catch(() => undefined);
      throw new LibError(
        LibErrorKind.ValidationUnavailable,
        'Synchronous model validation cannot use an asynchronous validator.',
      );
    }
  }
  throw new TypeError('A validation engine must return a boolean result.');
}

/**
 * Codec ids registered for a model class, as a non-enumerable own property of
 * its prototype. Validation reads it without a registry import, so standalone
 * validators stay free of code generation. Must match `ajv-keywords.ts`.
 */
export const MODEL_CODEC_IDS = Symbol.for('@exprtlabs/golem:modelCodecIds');

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
  if (variant > 0) {
    markModelCodecId(ctor, name.slice(0, variant));
    codecIdByConstructor.set(ctor, name.slice(0, variant));
    return;
  }
  markModelCodecId(ctor, name);
  codecIdByConstructor.set(ctor, name);
  if (name.includes('_') && HASHED_CODEC_SUFFIX.test(name.slice(name.lastIndexOf('_') + 1))) return;
  const prefix = `${name}_`;
  for (const key of iModelClasses.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (!HASHED_CODEC_SUFFIX.test(key.slice(prefix.length))) continue;
    iModelClasses.set(key, ctor);
    codecIdByConstructor.set(ctor, key);
    markModelCodecId(ctor, key);
  }
}

export function findCodecIdForConstructor(constructor: Function): string | undefined {
  return codecIdByConstructor.get(constructor);
}

export function getIModelClass(name: string): (abstract new (values?: never) => object) | undefined {
  const exact = iModelClasses.get(name);
  if (exact) return exact;
  if (name.includes('_') && HASHED_CODEC_SUFFIX.test(name.slice(name.lastIndexOf('_') + 1))) return undefined;
  const prefix = `${name}_`;
  let found: (abstract new (values?: never) => object) | undefined;
  for (const [key, ctor] of iModelClasses) {
    if (!key.startsWith(prefix)) continue;
    if (!HASHED_CODEC_SUFFIX.test(key.slice(prefix.length))) continue;
    if (found) return undefined;
    found = ctor;
  }
  return found;
}

export function requireIModelClass(name: string): abstract new (values?: never) => object {
  const ctor = getIModelClass(name);
  if (!ctor) {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      `IModel class ${JSON.stringify(name)} is not registered.`,
    );
  }
  return ctor;
}

export function registerObjectCodec<T>(codec: ObjectCodec<T>): void {
  codecs.set(codec.id, codec);
}

export function getObjectCodec<T = unknown>(id: string): ObjectCodec<T> | undefined {
  const exact = codecs.get(id) as ObjectCodec<T> | undefined;
  if (exact) return exact;
  if (id.includes('_') && HASHED_CODEC_SUFFIX.test(id.slice(id.lastIndexOf('_') + 1))) return undefined;
  const prefix = `${id}_`;
  let found: ObjectCodec<T> | undefined;
  for (const [key, codec] of codecs) {
    if (!key.startsWith(prefix)) continue;
    if (!HASHED_CODEC_SUFFIX.test(key.slice(prefix.length))) continue;
    if (found) return undefined;
    found = codec as ObjectCodec<T>;
  }
  return found;
}

export function requireObjectCodec<T = unknown>(id: string): ObjectCodec<T> {
  const codec = getObjectCodec<T>(id);
  if (!codec) {
    const hash = id.lastIndexOf('_');
    const model = hash > 0 && HASHED_CODEC_SUFFIX.test(id.slice(hash + 1)) ? id.slice(0, hash) : id;
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      `IObject codec ${JSON.stringify(id)} for model ${model} is not registered. `
      + `The generated file that registers it (the model file's .model.generated.js) has not been loaded; `
      + `a type-only import such as \`import type { ${model} }\` does not load it. `
      + `Import the model's .model.generated.js file, or a value from its model file, before calling parse, stringify, validate or the wire-format functions.`,
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
        code: IssueCode.InvalidJson,
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
  const encoded = JSON.stringify(value);
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

function issueSourceFromAjvError(raw: unknown, fallback: IssueSource): IssueSource {
  if (raw === null || typeof raw !== 'object') return fallback;
  const error = raw as Record<string, unknown>;
  if (Object.values(IssueSource).includes(error.source as IssueSource)) {
    return error.source as IssueSource;
  }
  const schemaPath = typeof error.schemaPath === 'string' ? error.schemaPath : '';
  if (!schemaPath || schemaPath.startsWith('#')) return fallback;
  const schemaId = schemaPath.split(/[#/]/)[0];
  if (!schemaId) return fallback;
  return getObjectCodec(schemaId)?.issueSource ?? fallback;
}

export function ajvIssues(
  validator: ModelRuntimeValidator,
  value: unknown,
  representation: IssueRepresentation = IssueRepresentation.Wire,
  source: IssueSource = IssueSource.OpenAPI,
): readonly Issue[] {
  const errors = validator.errors ?? [];
  return ajvIssuesFromErrors(errors, value, representation, source);
}

/** Convert an invocation-local error snapshot without rereading mutable validator state. */
export function ajvIssuesFromErrors(
  errors: readonly unknown[],
  value: unknown,
  representation: IssueRepresentation = IssueRepresentation.Wire,
  source: IssueSource = IssueSource.OpenAPI,
): readonly Issue[] {
  const issues = issuesFromErrors(errors, value, source, representation);
  if (errors.length === 0) return issues;
  return issues.map((issue, index) => {
    if (issue.source === IssueSource.Custom) return issue;
    const next = issueSourceFromAjvError(errors[index], source);
    if (next === issue.source) return issue;
    return { ...issue, source: next };
  });
}

/**
 * The body of a generated assert function: checks `value` with the module's own fail-fast or all-errors
 * validator, or with the validation context's validator for `reference`, and throws the validation error.
 */
export function assertModelValue(
  value: unknown,
  options: ValidateOptions | undefined,
  first: ModelRuntimeSyncValidator,
  all: ModelRuntimeSyncValidator,
  reference: string,
  representation: IssueRepresentation,
  source: IssueSource,
): void {
  const failFast = options?.failFast !== false;
  if (options?.validationContext === undefined) {
    const validator = failFast ? first : all;
    if (!validator(value)) validationFailure(ajvIssues(validator, value, representation, source));
    return;
  }
  const validator = resolveModelValidationContextValidator(options.validationContext, reference, failFast ? 'first' : 'all');
  if (!runSynchronousValidation(validator, value)) validationFailure(ajvIssues(validator, value, representation, source));
}

export function validationFailure(issues: readonly Issue[]): never {
  throw new LibError(LibErrorKind.Validation, 'Model validation failed.', issues);
}

export function validationUnavailable(message?: string): never {
  throw new LibError(
    LibErrorKind.ValidationUnavailable,
    message ?? 'Ajv validation is not generated for this profile.',
  );
}

export function requireAjvSchema(
  validator: ModelRuntimeSyncValidator | undefined,
  id: string,
): ModelRuntimeSyncValidator {
  if (!validator) throw new Error(`IObject validator missing: ${id}`);
  return validator;
}

/**
 * A validator that compiles on its first call. A generated module that
 * references models of other generated modules adds their schemas then, so
 * modules that import each other can finish loading first.
 */
export function lazyAjvSchema(
  compile: () => ModelRuntimeSyncValidator | undefined,
  id: string,
): ModelRuntimeSyncValidator {
  let compiled: ModelRuntimeSyncValidator | undefined;
  const validator = function lazyValidator(this: unknown, value: unknown): boolean {
    compiled ??= requireAjvSchema(compile(), id);
    return compiled.call(this, value);
  };
  Object.defineProperty(validator, 'errors', { enumerable: true, get: () => compiled?.errors ?? null });
  return validator as ModelRuntimeSyncValidator;
}

/** Default Ajv on when the golem profile enabled it; `{ validate: false }` skips. */
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

export function createObjectCodec<T>(id: string, impl: ObjectCodecImpl<T>): ObjectCodec<T> {
  let errors: readonly unknown[] | null = null;
  const schema = impl.schema
    ? impl.schemaRefsResolved ? impl.schema : resolveGeneratedModelSchemaRefs(impl.schema)
    : undefined;
  const planeSchema = (value: object | undefined, plane: ValidationPlane): object | undefined => value
    ? impl.schemaRefsResolved ? value : resolveGeneratedModelSchemaRefs(value, plane)
    : undefined;
  const wireSchema = planeSchema(impl.wireSchema, 'wire');
  const modelOnlySchema = planeSchema(impl.modelOnlySchema, 'model-only');
  const wireOnlySchema = planeSchema(impl.wireOnlySchema, 'wire-only');
  const codec: ObjectCodec<T> = {
    id,
    schema,
    wireSchema,
    ...(modelOnlySchema ? { modelOnlySchema } : {}),
    ...(wireOnlySchema ? { wireOnlySchema } : {}),
    issueSource: impl.issueSource,
    get errors() {
      return errors;
    },
    stringify: (value, options) => impl.stringify(value, options),
    parse: (text, options) => impl.parse(text, options),
    validate: (value, options): value is T => {
      const ok = impl.validate(value, options);
      errors = impl.validate.errors ?? null;
      return ok;
    },
    assert: (value, options) => impl.assert(value, options),
    // The generated implementation returns the emitted JSON type, which WireFormat mirrors.
    toWireFormat: <Value extends T>(value: Value, options?: SerdeOptions) => impl.toWireFormat(value, options) as WireFormat<Value>,
    fromWireFormat: (wire, options) => impl.fromWireFormat(wire, options),
  };
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

/**
 * Parent companions intern SDK models under the sanitized manifest id
 * (`fixture_money`). The nested codec is registered under its own id (`Money`
 * or `Money_xxxxxxxx`). Alias the intern id so `$ref` rewrite can find it.
 */
export function addNestedCodecSchema(
  addSchema: SchemaWriters,
  shortId: string,
  constructor?: Function,
  /**
   * Codec ids whose schemas the engines already hold. When given, the codecs
   * a nested schema references by id are added too, each once.
   */
  added?: Set<string>,
): string {
  let codec = getObjectCodec(shortId);
  if (!codec && constructor) {
    const bound = findCodecIdForConstructor(constructor);
    if (bound) codec = getObjectCodec(bound);
  }
  if (!codec) {
    throw new LibError(
      LibErrorKind.ValidationUnavailable,
      `IObject codec ${JSON.stringify(shortId)} is not registered.`,
    );
  }
  if (!codecs.has(shortId)) codecs.set(shortId, codec);
  return writeCodecSchemas(addSchema, codec, added, added !== undefined);
}

type SchemaWriters = ((schema: object, id: string) => void) | readonly ((schema: object, id: string) => void)[];

/**
 * Register every schema a codec has (model, wire, model-only, wire-only) and
 * those of the codecs it references, each once. Fills an engine for a
 * validation context.
 */
export function registerCodecSchemas(addSchema: SchemaWriters, codecOrId: ObjectCodec | string, added = new Set<string>()): string {
  const codec = typeof codecOrId === 'string' ? requireObjectCodec(codecOrId) : codecOrId;
  return writeCodecSchemas(addSchema, codec, added, true);
}

function writeCodecSchemas(addSchema: SchemaWriters, codec: ObjectCodec, added: Set<string> | undefined, recurse: boolean): string {
  if (codec.schema === undefined) {
    validationUnavailable(`Nested codec schema is missing: ${codec.id}`);
  }
  if (added?.has(codec.id)) return codec.id;
  added?.add(codec.id);
  const writers = Array.isArray(addSchema) ? addSchema : [addSchema];
  const planes: readonly ValidationPlane[] = ['model', 'wire', 'model-only', 'wire-only'];
  const schemas = planes.flatMap((plane) => {
    const schema = plane === 'wire' ? codec.wireSchema : codecPlaneSchema(codec, plane);
    return schema === undefined ? [] : [[schema, objectCodecValidationReference(codec, plane)] as const];
  });
  for (const write of writers) for (const [schema, id] of schemas) write(schema, id);
  if (recurse && added) {
    for (const reference of referencedCodecIds(schemas.map(([schema]) => schema))) {
      if (!added.has(reference)) writeCodecSchemas(addSchema, requireObjectCodec(reference), added, true);
    }
  }
  return codec.id;
}

/** Registered codecs a schema references by absolute id (`Id` or `Id#wire`). */
function referencedCodecIds(schemas: readonly unknown[]): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string' && !item.startsWith('#')) {
        const hash = item.indexOf('#');
        const id = hash < 0 ? item : item.slice(0, hash);
        if (codecs.has(id)) found.add(id);
      } else walk(item);
    }
  };
  schemas.forEach(walk);
  return found;
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
