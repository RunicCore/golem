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
import type { SchemaIssue } from './issue-messages.js';
import type { ModelValidationContext, WireFormat } from './model.js';
import type { GolemLayer } from './serde.js';
import type { Validator } from './validation-runtime.js';

import { GENERATED_MODEL_SCHEMA_REF_PREFIX } from './schema-keywords.js';

/** The error a generic serde call throws when no build has rewritten its type argument. */
export function untransformedCallError(name: string): LibError {
  return new LibError(
    LibErrorKind.ValidationUnavailable,
    `${name}<T> was not rewritten to a generated function. Build with \`golem build\`, the golem Vite or esbuild plugin, or Node with \`--import @exprtlabs/golem/register\`; a package loaded through \`node_modules\` (\`preserveSymlinks\`) is not rewritten.`,
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
  validate(value: unknown, options?: ValidateOptions): boolean;
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
  readonly first: Map<string, Validator>;
  readonly all: Map<string, Validator>;
}
const contextValidators = new WeakMap<ModelValidationContext, ContextValidatorCache>();
const HASHED_CODEC_SUFFIX = /^[0-9a-f]{8}$/;

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
      + `The generated file that registers it (the model file's \`.generated.js\` companion, such as \`order.entity.generated.js\` for \`order.entity.ts\`) has not been loaded; `
      + `a type-only import such as \`import type { ${model} }\` does not load it. `
      + `Import the model's \`.generated.js\` companion, or a value from its model file, before calling parse, stringify, validate or the wire-format functions.`,
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
  const issues: unknown = run(value, all);
  if (Array.isArray(issues)) return issues as readonly SchemaIssue[];
  if (issues !== null && typeof issues === 'object' && typeof Reflect.get(issues, 'then') === 'function') {
    // A synchronous API cannot await this result, but consuming it keeps a rejected override from becoming an unhandled rejection.
    void Promise.resolve(issues).catch(() => undefined);
    throw new LibError(LibErrorKind.ValidationUnavailable, 'Synchronous model validation cannot use an asynchronous validator.');
  }
  throw new TypeError('A validator must return an array of issues.');
}

/**
 * The validator the app layer holds for `reference`. An app that does not validate holds none. With `followsProfile`,
 * a model that sets no `validation` is validated only when the profile validates, even if the layer compiled its validator.
 */
export function layerValidator(layer: GolemLayer, reference: string, followsProfile = false): Validator {
  if ((followsProfile && !layer.profile.validation) || !Object.hasOwn(layer.validators, reference)) return validationUnavailable();
  return layer.validators[reference];
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

/** Whether a schema still holds a generated-model placeholder that names a codec by id. */
function holdsSchemaPlaceholder(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsSchemaPlaceholder);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    key === '$ref' && typeof item === 'string' && item.startsWith(GENERATED_MODEL_SCHEMA_REF_PREFIX)
  ) || holdsSchemaPlaceholder(item));
}

/**
 * The schema planes the app layer holds for codec `id`, each resolved on first use. A schema refers to other codecs by
 * id, and the codec of a model in an import cycle is not registered yet when this one is.
 */
function layerSchemaPlanes(layer: GolemLayer, id: string): Pick<ObjectCodec, 'schema' | 'wireSchema' | 'modelOnlySchema' | 'wireOnlySchema'> {
  const lazyPlane = (key: string, plane: ValidationPlane): (() => object | undefined) => {
    let resolved: object | undefined;
    return () => {
      if (resolved === undefined && Object.hasOwn(layer.schemas, key)) {
        const schema = layer.schemas[key];
        resolved = holdsSchemaPlaceholder(schema) ? resolveGeneratedModelSchemaRefs(schema, plane) : schema;
      }
      return resolved;
    };
  };
  const schema = lazyPlane(id, 'model');
  const wireSchema = lazyPlane(`${id}#wire`, 'wire');
  const modelOnlySchema = lazyPlane(`${id}#model-only`, 'model-only');
  const wireOnlySchema = lazyPlane(`${id}#wire-only`, 'wire-only');
  return {
    get schema() { return schema(); },
    get wireSchema() { return wireSchema(); },
    get modelOnlySchema() { return modelOnlySchema(); },
    get wireOnlySchema() { return wireOnlySchema(); },
  };
}

/** Registers the codec of `id`. With `layer`, its schemas come from `layer.schemas`; without it, from `impl`. */
export function createObjectCodec<T>(id: string, impl: ObjectCodecImpl<T>, layer?: GolemLayer): ObjectCodec<T> {
  const schemaRefs = layer === undefined ? undefined : layerSchemaPlanes(layer, id);
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
    ...(schemaRefs === undefined ? {
      schema,
      wireSchema,
      ...(modelOnlySchema ? { modelOnlySchema } : {}),
      ...(wireOnlySchema ? { wireOnlySchema } : {}),
    } : {}),
    issueSource: impl.issueSource,
    stringify: (value, options) => impl.stringify(value, options),
    parse: (text, options) => impl.parse(text, options),
    validate: (value, options): value is T => impl.validate(value, options),
    assert: (value, options) => impl.assert(value, options),
    // The generated implementation returns the emitted JSON type, which WireFormat mirrors.
    toWireFormat: <Value extends T>(value: Value, options?: SerdeOptions) => impl.toWireFormat(value, options) as WireFormat<Value>,
    fromWireFormat: (wire, options) => impl.fromWireFormat(wire, options),
  };
  // Copy the descriptors, not the values: a spread would run the getters and resolve the schemas now.
  if (schemaRefs !== undefined) Object.defineProperties(codec, Object.getOwnPropertyDescriptors(schemaRefs));
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
