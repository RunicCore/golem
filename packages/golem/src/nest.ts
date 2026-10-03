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
import { LibError } from './errors.js';
import { VALIDATION_KEYWORD } from './schema-keywords.js';
import { getIModelClass, getObjectCodec, type ObjectCodec } from './object-codec.js';

const NEST_MODEL_CODEC_ID = Symbol.for('@exprtlabs/golem:nestModelCodec');
const NEST_MODEL_CODEC = Symbol.for('@exprtlabs/golem:nestModelCodec.codec');
const NEST_MODEL_CONSTRUCT = Symbol.for('@exprtlabs/golem:nestModelCodec.construct');
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

type NestModelToken = Function & {
  readonly [NEST_MODEL_CODEC_ID]?: unknown;
  readonly [NEST_MODEL_CODEC]?: ObjectCodec;
  readonly [NEST_MODEL_CONSTRUCT]?: abstract new (values?: never) => object;
};

function reflectMeta(): ReflectParamtypes {
  return Reflect as typeof Reflect & ReflectParamtypes;
}

function nestModelMetatype(id: string): Function {
  const Token = class {};
  Object.defineProperty(Token, 'name', { value: id });
  Object.defineProperty(Token, NEST_MODEL_CODEC_ID, { value: id });
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

function boundConstruct(metatype: unknown): (abstract new (values?: never) => object) | undefined {
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

export function nestModelCodec(id: string): ParameterDecorator {
  const token = nestModelMetatype(id);
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
    const handler = context.getHandler();
    const klass = context.getClass();
    // Inbound conversion only. Validation and invalid JSON become HTTP 400. Any other error stays HTTP 500.
    try {
      const args = routeArgs(klass, handler.name);
      if (args) {
        const types = (reflectMeta().getMetadata('design:paramtypes', klass.prototype, handler.name) as unknown[] | undefined)
          ?? [];
        const req = context.switchToHttp().getRequest<HttpRequest>();
        const convertedSources = new Map<number, { codec: ObjectCodec; construct: unknown }>();
        for (const [key, meta] of Object.entries(args)) {
          const colon = key.indexOf(':');
          const paramtype = Number(colon >= 0 ? key.slice(0, colon) : key);
          if (paramtype !== NEST_BODY && paramtype !== NEST_QUERY) continue;
          // @Body('field') or @Query('field') is one field, so leave it with Nest.
          if (typeof meta.data === 'string' && meta.data !== '') continue;
          const metatype = types[meta.index];
          const codec = boundCodec(metatype);
          if (!codec) continue;
          const construct = boundConstruct(metatype);
          const previous = convertedSources.get(paramtype);
          if (previous) {
            if (previous.codec !== codec || previous.construct !== construct) {
              throw new TypeError('NestModelInterceptor requires one model type for each whole body or query object.');
            }
            continue;
          }
          const wire = paramtype === NEST_BODY ? req.body : queryWireDecoder(codec)(req.query);
          const converted = codec.fromWireFormat(wire, {
            failFast: true,
            construct,
          });
          // @Body() and @Query() read this field when next.handle() runs.
          if (paramtype === NEST_BODY) req.body = converted;
          else replaceQuery(req, converted);
          convertedSources.set(paramtype, { codec, construct });
        }
      }
    } catch (error) {
      httpError(error);
    }
    const declared = this.returnMetadata(klass, handler);
    const codec = declared ? getObjectCodec(declared.id) : undefined;
    if (!declared || !codec) return next.handle();
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
