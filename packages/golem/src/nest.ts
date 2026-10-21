/**
 * Optional Nest helpers. Golem's build-time rewrite registers codec
 * identity on `@Body()` / `@Query()` parameters via `nestModelCodec`; it does
 * not attach an interceptor or pipe. `nestModelCodec` binds the codec when
 * the controller class loads. The same rewrite records an `IModel` or
 * `IObject` return type, including `Promise` and an array of that type, with
 * `nestModelReturn`. `NestModelInterceptor` parses body and query parameters
 * to the declared type or class with fail-fast validation (query strings are
 * first decoded to the schema's declared scalar and array types) and writes the
 * result onto `req`. When the handler returns that model, the interceptor
 * stringifies it. Any other return type stays Nest JSON. Consumers may
 * register the interceptor or write their own interceptor or pipe with
 * `objectCodecFromMetatype`. `nestModelStringifyInterceptor` stays for a
 * response whose codec is not the declared return type.
 */
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { mergeMap, type Observable } from 'rxjs';
import { IssueRepresentation, IssueSource, LibError, LibErrorKind, type IssuePath } from './errors.js';
import { VALIDATION_KEYWORD } from './schema-keywords.js';
import { getIModelClass, getObjectCodec, type ObjectCodec } from './object-codec.js';

const NEST_MODEL_CODEC_ID = Symbol.for('@exprtlabs/golem:nestModelCodec');
const NEST_MODEL_CODEC = Symbol.for('@exprtlabs/golem:nestModelCodec.codec');
const NEST_MODEL_CONSTRUCT = Symbol.for('@exprtlabs/golem:nestModelCodec.construct');
const NEST_MODEL_ARRAY = Symbol.for('@exprtlabs/golem:nestModelCodec.array');
const NEST_MODEL_RETURN = '@exprtlabs/golem:nestModelReturn';
const ROUTE_ARGS_METADATA = '__routeArguments__';
const NEST_BODY = 3;
const NEST_QUERY = 4;
const FORWARDED_NULL = Promise.resolve(null);
const FORWARDED_UNDEFINED = Promise.resolve(undefined);

type ReflectParamtypes = {
  defineMetadata(key: string, value: unknown, target: object, propertyKey: string | symbol): void;
  getOwnMetadata(key: string, target: object, propertyKey: string | symbol): unknown;
  getMetadata(key: string, target: object, propertyKey: string | symbol): unknown;
};

type RouteArgMeta = {
  readonly index: number;
  readonly data?: unknown;
};

type HttpRequest = {
  body?: unknown;
  query?: unknown;
};

type HttpResponse = {
  readonly setHeader?: (name: string, value: string) => unknown;
  readonly header?: (name: string, value: string) => unknown;
};

/**
 * Marks the response as JSON and yields the serialized text as the route
 * result. Nest writes it: an interceptor that sent the response itself and
 * completed empty would make Nest's lastValueFrom throw EmptyError.
 */
type JsonResponseWriter = (response: HttpResponse, text: string) => Promise<string>;
type JsonModelProjection = (value: unknown) => Observable<unknown> | Promise<unknown>;
type JsonModelProjectionFactory = (
  response: HttpResponse,
  codec: ObjectCodec,
  array: boolean,
) => JsonModelProjection;

type NestReturnMeta = {
  readonly id: string;
  readonly array: boolean;
};

type NestModelConstruct = abstract new (values?: never) => object;

type NestModelToken = Function & {
  readonly [NEST_MODEL_CODEC_ID]?: unknown;
  readonly [NEST_MODEL_CODEC]?: ObjectCodec;
  readonly [NEST_MODEL_CONSTRUCT]?: NestModelConstruct;
  readonly [NEST_MODEL_ARRAY]?: true;
};

function reflectMeta(): ReflectParamtypes {
  return Reflect as typeof Reflect & ReflectParamtypes;
}

function nestModelMetatype(id: string, array: boolean): Function {
  const Token = class {};
  Object.defineProperty(Token, 'name', { value: id });
  Object.defineProperty(Token, NEST_MODEL_CODEC_ID, { value: id });
  if (array) Object.defineProperty(Token, NEST_MODEL_ARRAY, { value: true });
  const codec = getObjectCodec(id);
  if (codec) {
    Object.defineProperty(Token, NEST_MODEL_CODEC, { value: codec });
    const construct = getIModelClass(id);
    if (construct) Object.defineProperty(Token, NEST_MODEL_CONSTRUCT, { value: construct });
  }
  return Token;
}

function asToken(metatype: unknown): NestModelToken | undefined {
  return typeof metatype === 'function' ? metatype as NestModelToken : undefined;
}

function codecIdFromMetatype(metatype: unknown): string | undefined {
  const token = asToken(metatype);
  const registered = token?.[NEST_MODEL_CODEC_ID];
  if (typeof registered === 'string' && registered !== '') return registered;
  return undefined;
}

function boundCodec(metatype: unknown): ObjectCodec | undefined {
  return asToken(metatype)?.[NEST_MODEL_CODEC];
}

function boundArray(metatype: unknown): boolean {
  return asToken(metatype)?.[NEST_MODEL_ARRAY] === true;
}

function boundConstruct(metatype: unknown): NestModelConstruct | undefined {
  return asToken(metatype)?.[NEST_MODEL_CONSTRUCT];
}

function routeArgs(klass: Function, name: string): Record<string, RouteArgMeta> | undefined {
  let current: unknown = klass;
  while (typeof current === 'function') {
    const args = reflectMeta().getMetadata(ROUTE_ARGS_METADATA, current, name) as
      | Record<string, RouteArgMeta>
      | undefined;
    if (args) return args;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/** Request input the model rejects is a 400; any other failure stays a server error. */
function httpError(error: unknown): never {
  if (error instanceof LibError && error.causedByInput) {
    throw new BadRequestException({ issues: error.issues });
  }
  throw error;
}

// #region nest-model-http
export function nestModelReturn(id: string, array?: boolean): MethodDecorator {
  const meta: NestReturnMeta = { id, array: array === true };
  return (target, propertyKey) => {
    if (propertyKey === undefined) return;
    reflectMeta().defineMetadata(NEST_MODEL_RETURN, meta, target, propertyKey);
  };
}

export function nestModelCodec(id: string, array?: boolean): ParameterDecorator {
  const token = nestModelMetatype(id, array === true);
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) return;
    const meta = reflectMeta();
    const types = Array.from(
      (meta.getOwnMetadata('design:paramtypes', target, propertyKey) as unknown[] | undefined) ?? [],
    );
    types[parameterIndex] = token;
    meta.defineMetadata('design:paramtypes', types, target, propertyKey);
  };
}

export function objectCodecFromMetatype<T = unknown>(metatype: unknown): ObjectCodec<T> | undefined {
  const bound = boundCodec(metatype);
  if (bound) return bound as ObjectCodec<T>;
  const id = codecIdFromMetatype(metatype);
  if (!id) return undefined;
  return getObjectCodec<T>(id);
}

export function nestModelConstruct(metatype: unknown): (abstract new (values?: never) => object) | undefined {
  const bound = boundConstruct(metatype);
  if (bound) return bound;
  const id = codecIdFromMetatype(metatype);
  if (!id) return undefined;
  return getIModelClass(id);
}

function returnMeta(value: unknown): NestReturnMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id !== 'string' || id === '') return undefined;
  return { id, array: (value as { array?: unknown }).array === true };
}

function declaredReturn(klass: Function, name: string): NestReturnMeta | undefined {
  let current: unknown = klass.prototype;
  while (current && current !== Object.prototype) {
    const meta = returnMeta(reflectMeta().getOwnMetadata(NEST_MODEL_RETURN, current, name));
    if (meta) return meta;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function stringifyModel(codec: ObjectCodec, value: unknown, array: boolean): string {
  if (array && Array.isArray(value)) {
    return `[${value.map((item) => codec.stringify(item)).join(',')}]`;
  }
  return codec.stringify(value);
}

function sendExpressJson(response: HttpResponse, text: string): Promise<string> {
  const expressResponse = response as HttpResponse & {
    setHeader(name: string, value: string): unknown;
  };
  expressResponse.setHeader('Content-Type', 'application/json; charset=utf-8');
  return Promise.resolve(text);
}

function sendFastifyJson(response: HttpResponse, text: string): Promise<string> {
  const fastifyReply = response as HttpResponse & {
    header(name: string, value: string): unknown;
  };
  fastifyReply.header('Content-Type', 'application/json; charset=utf-8');
  return Promise.resolve(text);
}

function jsonResponseWriter(response: HttpResponse): JsonResponseWriter {
  if (typeof response.setHeader === 'function') return sendExpressJson;
  if (typeof response.header === 'function') return sendFastifyJson;
  throw new TypeError('NestModelInterceptor requires an HTTP response with setHeader() or header().');
}

function expressModelProjection(
  response: HttpResponse,
  codec: ObjectCodec,
  array: boolean,
): JsonModelProjection {
  return function projectExpressModel(value): Observable<unknown> | Promise<unknown> {
    if (value === undefined) return FORWARDED_UNDEFINED;
    if (value === null) return FORWARDED_NULL;
    return sendExpressJson(response, stringifyModel(codec, value, array));
  };
}

function fastifyModelProjection(
  response: HttpResponse,
  codec: ObjectCodec,
  array: boolean,
): JsonModelProjection {
  return function projectFastifyModel(value): Observable<unknown> | Promise<unknown> {
    if (value === undefined) return FORWARDED_UNDEFINED;
    if (value === null) return FORWARDED_NULL;
    return sendFastifyJson(response, stringifyModel(codec, value, array));
  };
}

function jsonModelProjectionFactory(response: HttpResponse): JsonModelProjectionFactory {
  if (typeof response.setHeader === 'function') return expressModelProjection;
  if (typeof response.header === 'function') return fastifyModelProjection;
  throw new TypeError('NestModelInterceptor requires an HTTP response with setHeader() or header().');
}

function replaceQuery(request: HttpRequest, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(request, 'query');
  if (own && !own.configurable) {
    if ('value' in own && own.writable) {
      Object.defineProperty(request, 'query', { value });
      return;
    }
    throw new TypeError('NestModelInterceptor cannot replace the adapter\'s non-configurable query property.');
  }
  // Express parses query through an inherited getter. Shadow it on this request.
  Object.defineProperty(request, 'query', {
    value,
    writable: true,
    configurable: true,
    enumerable: own?.enumerable ?? true,
  });
}

/** What a query field's schema admits, reduced to what a query string can carry. */
type QueryFieldShape = {
  readonly types: Set<string>;
  readonly literals: unknown[];
  item?: QueryFieldShape;
};
type QueryWireDecoder = (query: unknown) => unknown;

const NOT_DECODED = Symbol('not decoded');
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const queryWireDecoders = new WeakMap<ObjectCodec, QueryWireDecoder>();

function schemaRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function collectQueryShape(schema: unknown, shape: QueryFieldShape): void {
  if (schema === true) {
    shape.types.add('string');
    return;
  }
  const record = schemaRecord(schema);
  if (!record) return;
  const types = typeof record.type === 'string' ? [record.type] : Array.isArray(record.type) ? record.type : [];
  for (const type of types) if (typeof type === 'string') shape.types.add(type);
  if ('const' in record) shape.literals.push(record.const);
  if (Array.isArray(record.enum)) shape.literals.push(...record.enum);
  if (types.includes('array')) {
    shape.item ??= { types: new Set(), literals: [] };
    collectQueryShape(record.items, shape.item);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = record[keyword];
    if (Array.isArray(branches)) for (const branch of branches) collectQueryShape(branch, shape);
  }
  collectQueryShape(schemaRecord(record[VALIDATION_KEYWORD])?.schema, shape);
}

function collectQueryProperties(schema: unknown, fields: Map<string, QueryFieldShape>): void {
  const record = schemaRecord(schema);
  if (!record) return;
  const properties = schemaRecord(record.properties);
  if (properties) {
    for (const [name, property] of Object.entries(properties)) {
      let shape = fields.get(name);
      if (!shape) {
        shape = { types: new Set(), literals: [] };
        fields.set(name, shape);
      }
      collectQueryShape(property, shape);
    }
  }
  if (Array.isArray(record.allOf)) for (const branch of record.allOf) collectQueryProperties(branch, fields);
  collectQueryProperties(schemaRecord(record[VALIDATION_KEYWORD])?.schema, fields);
}

function decodeQueryScalar(text: string, shape: QueryFieldShape): unknown {
  if (shape.types.has('string') || shape.literals.includes(text)) return text;
  const literal = shape.literals.find((value) =>
    (typeof value === 'number' || typeof value === 'boolean') && String(value) === text);
  if (literal !== undefined) return literal;
  if ((shape.types.has('number') || shape.types.has('integer')) && JSON_NUMBER.test(text)) {
    const value = Number(text);
    // An integer outside the safe range would decode to a different value.
    if (!shape.types.has('integer') || Number.isSafeInteger(value)) return value;
  }
  if (shape.types.has('boolean') && (text === 'true' || text === 'false')) return text === 'true';
  return NOT_DECODED;
}

function decodeQueryItems(values: readonly unknown[], item: QueryFieldShape): unknown[] {
  return values.map((entry) => {
    if (typeof entry !== 'string') return entry;
    const decoded = decodeQueryScalar(entry, item);
    return decoded === NOT_DECODED ? entry : decoded;
  });
}

function decodeQueryField(value: unknown, shape: QueryFieldShape): unknown {
  if (Array.isArray(value)) return shape.item ? decodeQueryItems(value, shape.item) : value;
  if (typeof value !== 'string') return value;
  const decoded = decodeQueryScalar(value, shape);
  if (decoded !== NOT_DECODED) return decoded;
  // A single occurrence of a repeatable key arrives as a string.
  return shape.item ? decodeQueryItems([value], shape.item) : value;
}

/**
 * Query values arrive as strings or repeated-key string arrays. Decode each
 * field to the scalar or array type its schema declares before the model's
 * wire validation runs. A value that does not fit stays a string, so the
 * validator reports it. Body JSON keeps its own types and is not decoded.
 */
/** Whether a query string (scalar) can decode to something other than itself. */
function decodesScalar(shape: QueryFieldShape): boolean {
  if (shape.types.has('string')) return false;
  return shape.types.has('number') || shape.types.has('integer') || shape.types.has('boolean')
    || shape.literals.some((value) => typeof value === 'number' || typeof value === 'boolean');
}

/** Whether decodeQueryField can return a value different from its input. */
function decodesField(shape: QueryFieldShape): boolean {
  if (decodesScalar(shape)) return true;
  if (!shape.item) return false;
  // A single string becomes a one-item array unless the field also admits a string.
  return !shape.types.has('string') || decodesScalar(shape.item);
}

function queryWireDecoder(codec: ObjectCodec): QueryWireDecoder {
  const cached = queryWireDecoders.get(codec);
  if (cached) return cached;
  const fields = new Map<string, QueryFieldShape>();
  collectQueryProperties(codec.wireSchema ?? codec.schema, fields);
  const decoded = [...fields].filter(([, shape]) => decodesField(shape));
  const decoder: QueryWireDecoder = decoded.length === 0 ? (query) => query : (query) => {
    const record = schemaRecord(query);
    if (!record) return query;
    let copy: Record<string, unknown> | undefined;
    for (const [name, shape] of decoded) {
      if (!Object.hasOwn(record, name)) continue;
      copy ??= { ...record };
      // Define rather than assign so a field named __proto__ stays data.
      Object.defineProperty(copy, name, {
        value: decodeQueryField(record[name], shape), writable: true, enumerable: true, configurable: true,
      });
    }
    return copy ?? query;
  };
  queryWireDecoders.set(codec, decoder);
  return decoder;
}

const NO_DECODE = (value: unknown): unknown => value;

/** The error with `path` in front of each issue path; a path of no segments, or an error that is not a LibError, stays as it is. */
function prefixedError(error: unknown, path: IssuePath): unknown {
  if (path.length === 0 || !(error instanceof LibError)) return error;
  return new LibError(
    error.kind,
    error.message,
    error.issues.map((issue) => ({ ...issue, path: [...path, ...issue.path] })),
    { causedByInput: error.causedByInput, ...(error.cause === undefined ? {} : { cause: error.cause }) },
  );
}

/**
 * The model of one wire value, or of each item of an array wire value. `field` is the key of a one-field parameter, which
 * starts the path of each issue; an item that fails adds its index.
 */
function convertInput(
  codec: ObjectCodec,
  construct: NestModelConstruct | undefined,
  array: boolean,
  wire: unknown,
  decode: (wire: unknown) => unknown,
  field: string | undefined,
): unknown {
  const options = { failFast: true, construct };
  if (!array) {
    try {
      return codec.fromWireFormat(decode(wire), options);
    } catch (error) {
      throw prefixedError(error, field === undefined ? [] : [field]);
    }
  }
  if (!Array.isArray(wire)) {
    throw new LibError(LibErrorKind.Validation, 'Model validation failed.', [{
      code: 'type', expected: ['array'], message: 'Expected array', path: field === undefined ? [] : [field],
      source: IssueSource.Serde, representation: IssueRepresentation.Wire,
    }]);
  }
  return wire.map((item, index) => {
    try {
      return codec.fromWireFormat(decode(item), options);
    } catch (error) {
      throw prefixedError(error, field === undefined ? [index] : [field, index]);
    }
  });
}

function inputDecorator(paramtype: number, field: string | undefined): string {
  return `@${paramtype === NEST_BODY ? 'Body' : 'Query'}(${field === undefined ? '' : `'${field}'`})`;
}

// #region nest-model-interceptor
export class NestModelInterceptor implements NestInterceptor {
  // Nest return decorators are installed before controllers run, so an absent
  // method annotation is stable after the first lookup. Codec registration is
  // independent and remains checked for every request below.
  private readonly declaredReturns = new WeakMap<
    Function,
    WeakMap<Function, NestReturnMeta | null>
  >();

  // Resolve the adapter only when a model value is first written. This initial
  // projection belongs to this interceptor and keeps null-only streams valid.
  private modelProjectionFactory: JsonModelProjectionFactory = (response, codec, array) => {
    let projection: JsonModelProjection | undefined;
    return (value) => {
      if (value === undefined) return FORWARDED_UNDEFINED;
      if (value === null) return FORWARDED_NULL;
      if (!projection) {
        const factory = jsonModelProjectionFactory(response);
        this.modelProjectionFactory = factory;
        projection = factory(response, codec, array);
      }
      return projection(value);
    };
  };

  private returnMetadata(klass: Function, handler: Function): NestReturnMeta | undefined {
    const handlers = this.declaredReturns.get(klass);
    const cached = handlers?.get(handler);
    if (cached !== undefined) return cached ?? undefined;
    const metadata = declaredReturn(klass, handler.name);
    let returnByHandler = handlers;
    if (!returnByHandler) {
      returnByHandler = new WeakMap<Function, NestReturnMeta | null>();
      this.declaredReturns.set(klass, returnByHandler);
    }
    returnByHandler.set(handler, metadata ?? null);
    return metadata;
  }

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    // Body and query parameters are HTTP request input. An RPC or WebSocket handler has other parameters under the same numbers.
    if (context.getType() !== 'http') return next.handle();
    const handler = context.getHandler();
    const klass = context.getClass();
    // Inbound conversion only. Validation and invalid JSON become HTTP 400. Any other error stays HTTP 500.
    try {
      const args = routeArgs(klass, handler.name);
      if (args) {
        const types = (reflectMeta().getMetadata('design:paramtypes', klass.prototype, handler.name) as unknown[] | undefined)
          ?? [];
        const req = context.switchToHttp().getRequest<HttpRequest>();
        // A whole parameter keys by its source, a one-field parameter by its source and field.
        let converted: Map<number | string, { codec: ObjectCodec; construct: NestModelConstruct | undefined; array: boolean }> | undefined;
        // Bit 1 is the body, bit 2 the query.
        let wholeSources = 0;
        let fieldSources = 0;
        for (const [key, meta] of Object.entries(args)) {
          const colon = key.indexOf(':');
          const paramtype = Number(colon >= 0 ? key.slice(0, colon) : key);
          if (paramtype !== NEST_BODY && paramtype !== NEST_QUERY) continue;
          const field = typeof meta.data === 'string' && meta.data !== '' ? meta.data : undefined;
          const metatype = types[meta.index];
          const codec = boundCodec(metatype);
          if (!codec) {
            // A controller declaration fault, not bad input: Nest answers 500 for this request.
            const where = `${inputDecorator(paramtype, field)} parameter ${meta.index} of ${klass.name}.${handler.name}`;
            const id = codecIdFromMetatype(metatype);
            throw new TypeError(id === undefined
              ? `NestModelInterceptor needs an IModel or IObject type for ${where}. Declare the input as an IModel or IObject, or write your own interceptor.`
              : `golem fault: NestModelInterceptor found no registered codec "${id}" for ${where}. The rewrite loads the generated module of the model, and that module did not load. Run golem generate and rewrite the file again.`);
          }
          const construct = boundConstruct(metatype);
          const array = boundArray(metatype);
          const source = paramtype === NEST_BODY ? 1 : 2;
          if (field === undefined ? (fieldSources & source) !== 0 : (wholeSources & source) !== 0) {
            // The whole conversion replaces the value that a one-field parameter reads, so the two cannot both convert.
            throw new TypeError(
              `NestModelInterceptor cannot convert a whole and a one-field ${paramtype === NEST_BODY ? '@Body' : '@Query'}() of ${klass.name}.${handler.name} together. Declare the whole input as one model, or use one-field parameters only.`,
            );
          }
          if (field === undefined && array && paramtype === NEST_QUERY) {
            throw new TypeError(
              `NestModelInterceptor cannot convert a whole @Query() array of ${klass.name}.${handler.name}: a query is an object. Declare the query as one model.`,
            );
          }
          const convertedKey = field === undefined ? paramtype : `${paramtype}:${field}`;
          const previous = converted?.get(convertedKey);
          if (previous) {
            if (previous.codec !== codec || previous.construct !== construct || previous.array !== array) {
              throw new TypeError(field === undefined
                ? 'NestModelInterceptor requires one model type for each whole body or query object.'
                : `NestModelInterceptor requires one model type for ${inputDecorator(paramtype, field)} of ${klass.name}.${handler.name}.`);
            }
            continue;
          }
          const decode = paramtype === NEST_BODY ? NO_DECODE : queryWireDecoder(codec);
          // @Body() and @Query() read these values when next.handle() runs.
          if (field === undefined) {
            const value = convertInput(codec, construct, array, paramtype === NEST_BODY ? req.body : req.query, decode, undefined);
            if (paramtype === NEST_BODY) req.body = value;
            else replaceQuery(req, value);
            wholeSources |= source;
          } else {
            const record = schemaRecord(paramtype === NEST_BODY ? req.body : req.query);
            const value = convertInput(codec, construct, array, record && Object.hasOwn(record, field) ? record[field] : undefined, decode, field);
            // Copy so the incoming object is not mutated; define so a field named __proto__ stays data.
            const copy = { ...record };
            Object.defineProperty(copy, field, { value, writable: true, enumerable: true, configurable: true });
            if (paramtype === NEST_BODY) req.body = copy;
            else replaceQuery(req, copy);
            fieldSources |= source;
          }
          (converted ??= new Map()).set(convertedKey, { codec, construct, array });
        }
      }
    } catch (error) {
      httpError(error);
    }
    const declared = this.returnMetadata(klass, handler);
    // A return without the golem mark stays plain Nest JSON.
    if (!declared) return next.handle();
    const codec = getObjectCodec(declared.id);
    if (!codec) {
      // The build marked this return, so a missing codec is a golem fault, not a controller declaration: Nest answers 500 before the handler runs.
      throw new TypeError(
        `golem fault: the build marked the return of ${klass.name}.${handler.name} with model "${declared.id}", but the generated module of that model did not load, so its codec is not registered.`,
      );
    }
    const response = context.switchToHttp().getResponse<HttpResponse>();
    const source = next.handle();
    const project = this.modelProjectionFactory(response, codec, declared.array);
    return mergeMap(project)(source);
  }
}
// #endregion nest-model-interceptor

export function nestModelStringifyInterceptor(codec: ObjectCodec): NestInterceptor {
  let writeJson: JsonResponseWriter = (response, text) => {
    const writer = jsonResponseWriter(response);
    writeJson = writer;
    return writer(response, text);
  };
  return {
    intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
      const response = context.switchToHttp().getResponse<HttpResponse>();
      const writeJsonForResponse = writeJson;
      const source = next.handle();
      return mergeMap((value: unknown): Observable<unknown> | Promise<unknown> => {
        if (value === undefined) return FORWARDED_UNDEFINED;
        if (value === null) return FORWARDED_NULL;
        return writeJsonForResponse(response, stringifyModel(codec, value, Array.isArray(value)));
      })(source);
    },
  };
}
// #endregion nest-model-http
