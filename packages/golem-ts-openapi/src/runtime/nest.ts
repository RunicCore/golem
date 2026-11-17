/**
 * Optional Nest helpers. Golem's build-time rewrite registers codec
 * identity on `@Body()` / `@Query()` parameters with `nestModelCodec` and
 * records an `IModel` or `IObject` return type, including `Promise` and an
 * array of that type, with `nestModelReturn` (both live in `nest-binding.ts`,
 * which only generated code imports). The rewrite attaches no interceptor or pipe.
 * `NestModelInterceptor` parses body and query parameters
 * to the declared type or class with fail-fast validation (query strings are
 * first decoded to the scalar and array types the codec declares) and writes the
 * result onto `req`. When the handler returns that model, the interceptor
 * stringifies it. Any other return type stays Nest JSON. Consumers may
 * register the interceptor or write their own interceptor or pipe with
 * `objectCodecFromMetatype`, or `nestUnionFromMetatype` for a union of
 * models, and decode a query with `nestQueryDecoder`. `nestReturnCodec` gives
 * an interceptor the codec of the declared return. `nestModelStringifyInterceptor` stays for a response whose codec is
 * not the declared return type. The rewrite swaps a whole `@Headers()` typed as a model for a decorator
 * (`nestModelHeaders`) that reads the headers an interceptor decoded: `nestHeadersCodec` gives the call that decodes them, and
 * `setNestHeaders` hands the result to the handler. `NestModelInterceptor` does both.
 */
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { mergeMap, type Observable } from 'rxjs';
import { LibError, LibErrorKind, type IssuePath } from '@exprtlabs/golem/errors';
import { IssueRepresentation, IssueSource, recordOrUndefined, resolveMaxDepth } from '@exprtlabs/golem/internal/model-runtime';
import type { GeneratedModelConstructor } from '@exprtlabs/golem/model';
import { getIModelClass, getObjectCodec, type DecodeOptions, type ObjectCodec } from '@exprtlabs/golem/serde';
import {
  asToken,
  boundArray,
  boundCodec,
  boundConstruct,
  boundUnion,
  codecIdFromMetatype,
  NEST_HEADERS_SLOT,
  NEST_MODEL_HEADERS,
  NEST_MODEL_RETURN,
  NEST_MODEL_UNION_IDS,
  queryWireDecoder,
  reflectMeta,
  type ModelInput,
  type NestReturnMeta,
  type NestUnionInput,
} from './nest-binding.js';

export type { NestUnionInput };

const ROUTE_ARGS_METADATA = '__routeArguments__';
const NEST_BODY = 3;
const NEST_QUERY = 4;
const FORWARDED_NULL = Promise.resolve(null);
const FORWARDED_UNDEFINED = Promise.resolve(undefined);

type RouteArgMeta = {
  readonly index: number;
  readonly data?: unknown;
};

type HttpRequest = {
  body?: unknown;
  query?: unknown;
  headers?: unknown;
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
/** Whether two parameters take one model type: the same codec, or unions with the same tag and variants. */
function sameInput(left: ModelInput, right: ModelInput): boolean {
  return left === right || ('key' in left && 'key' in right && left.key === right.key);
}

export function objectCodecFromMetatype<T = unknown>(metatype: unknown): ObjectCodec<T> | undefined {
  const bound = boundCodec(metatype);
  if (bound) return bound as ObjectCodec<T>;
  const id = codecIdFromMetatype(metatype);
  if (!id) return undefined;
  return getObjectCodec<T>(id);
}

/**
 * The converter of a parameter token that `nestModelUnion` placed, such as the `design:paramtypes` entry of a `@Body()` or
 * `@Query()` parameter typed as a union of models. It is the converter `NestModelInterceptor` uses. `undefined` for any other token,
 * and for a union whose variant codecs are not registered yet.
 */
export function nestUnionFromMetatype(metatype: unknown): NestUnionInput | undefined {
  return boundUnion(metatype);
}

/**
 * The decoder of a query for a parameter token, such as the `design:paramtypes` entry of a `@Query()` parameter typed as one model or a union of models.
 * It turns query strings into the scalar and array types the model declares; a value that does not fit stays a string, so
 * `fromWireFormat` reports it. Pass the result to `fromWireFormat`. `undefined` for any other token, and for a union whose variant codecs are not registered yet.
 */
export function nestQueryDecoder(metatype: unknown): ((query: unknown) => unknown) | undefined {
  const union = boundUnion(metatype);
  if (union) return union.decodeQuery;
  const codec = objectCodecFromMetatype(metatype);
  return codec && queryWireDecoder(codec);
}

export function nestModelConstruct(metatype: unknown): GeneratedModelConstructor | undefined {
  const bound = boundConstruct(metatype);
  if (bound) return bound;
  const id = codecIdFromMetatype(metatype);
  if (!id) return undefined;
  return getIModelClass(id);
}

function returnMeta(value: unknown): NestReturnMeta | undefined {
  const meta = recordOrUndefined(value);
  if (!meta || typeof meta.id !== 'string' || meta.id === '') return undefined;
  return { id: meta.id, array: meta.array === true };
}

/** The value of the metadata `key` that the nearest class of the prototype chain holds for a handler, read by `read`. */
function declaredMeta<Meta>(klass: Function, name: string, key: string, read: (value: unknown) => Meta | undefined): Meta | undefined {
  let current: unknown = klass.prototype;
  while (current && current !== Object.prototype) {
    const meta = read(reflectMeta().getOwnMetadata(key, current, name));
    if (meta) return meta;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

const declaredReturn = (klass: Function, name: string): NestReturnMeta | undefined => declaredMeta(klass, name, NEST_MODEL_RETURN, returnMeta);
const declaredHeaders = (klass: Function, name: string): string | undefined => declaredMeta(klass, name, NEST_MODEL_HEADERS, (value) => typeof value === 'string' && value !== '' ? value : undefined);

/** The codec of a handler's declared return, and whether the handler returns an array of that model. */
export interface NestReturnCodec {
  readonly codec: ObjectCodec;
  readonly array: boolean;
}

/**
 * The codec of the declared return of a controller handler, for an interceptor that writes the response itself. The build marks a
 * handler whose explicit return type is a model, a `Promise` of a model or an array of a model. `undefined` for a handler with no
 * mark, such as one with no written return type or one that returns a union. It throws a `TypeError` that starts with
 * `golem fault` when the build marked the handler and the codec of that model is not registered, because the generated
 * module of the model did not load. The lookup runs at each call, so a codec that registers late is found. Cache the result for each handler if you need to.
 */
export function nestReturnCodec(controllerClass: Function, handler: Function): NestReturnCodec | undefined {
  const declared = declaredReturn(controllerClass, handler.name);
  if (!declared) return undefined;
  const codec = getObjectCodec(declared.id);
  if (!codec) {
    // The build marked this return, so a missing codec is a golem fault, not a controller declaration: Nest answers 500 before the handler runs.
    throw new TypeError(
      `golem fault: the build marked the return of ${controllerClass.name}.${handler.name} with model "${declared.id}", but the generated module of that model did not load, so its codec is not registered.`,
    );
  }
  return { codec, array: declared.array };
}

/** What an interceptor decodes the headers of a handler with. */
export interface NestHeadersCodec {
  /**
   * The model of the request headers: a header that holds empty text counts as not sent, and only the fields that the model declares stay.
   * Throws a `LibError` for headers the model rejects. `options` are the options of `fromWireFormat`, except the ones that this call sets.
   */
  decode(headers: unknown, options?: Omit<DecodeOptions, 'strip' | 'construct'>): unknown;
}

/** The headers of a request without the ones that hold empty text: an empty header is a header that was not sent. */
function presentHeaders(headers: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(recordOrUndefined(headers) ?? {}).filter(([, value]) => value !== ''));
}

/**
 * The decoder of the whole `@Headers()` parameter of a controller handler that the build rewrote, for an interceptor that decodes the
 * headers. Call `decode(request.headers)`, then store the result with `setNestHeaders`. `undefined` for a handler
 * with no such parameter: a `@Headers()` that is no model, such as `Record` or `any`, and every `@Headers('name')`, stay as Nest reads them. It
 * throws a `TypeError` that starts with `golem fault` when the build rewrote the parameter and the codec of its model is not registered.
 * The lookup runs at each call. Cache the result for each handler if you need to.
 */
export function nestHeadersCodec(controllerClass: Function, handler: Function): NestHeadersCodec | undefined {
  const id = declaredHeaders(controllerClass, handler.name);
  if (id === undefined) return undefined;
  const codec = getObjectCodec(id);
  if (!codec) {
    throw new TypeError(
      `golem fault: the build rewrote the @Headers() of ${controllerClass.name}.${handler.name} with model "${id}", but the generated module of that model did not load, so its codec is not registered.`,
    );
  }
  const construct = getIModelClass(id);
  return { decode: (headers, options) => codec.fromWireFormat(presentHeaders(headers), { ...options, strip: true, construct }) };
}

/**
 * Stores the decoded headers on the request, for the `@Headers()` parameter that the build rewrote. `request.headers` stays as received, so
 * `request.host` and the trace context keep working. A handler that runs with nothing stored fails with a `TypeError` that starts with `golem fault`.
 */
export function setNestHeaders(request: object, value: unknown): void {
  Object.defineProperty(request, NEST_HEADERS_SLOT, { value, writable: true, configurable: true });
}

function stringifyModel(codec: ObjectCodec, value: unknown, array: boolean): string {
  if (array && Array.isArray(value)) {
    return `[${value.map((item) => codec.stringify(item)).join(',')}]`;
  }
  return codec.stringify(value);
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function sendExpressJson(response: HttpResponse, text: string): Promise<string> {
  const expressResponse = response as HttpResponse & {
    setHeader(name: string, value: string): unknown;
  };
  expressResponse.setHeader('Content-Type', JSON_CONTENT_TYPE);
  return Promise.resolve(text);
}

function sendFastifyJson(response: HttpResponse, text: string): Promise<string> {
  const fastifyReply = response as HttpResponse & {
    header(name: string, value: string): unknown;
  };
  fastifyReply.header('Content-Type', JSON_CONTENT_TYPE);
  return Promise.resolve(text);
}

/** The writer of the adapter that `response` belongs to: Express sets a header with `setHeader`, Fastify with `header`. */
function jsonResponseWriter(response: HttpResponse): JsonResponseWriter {
  if (typeof response.setHeader === 'function') return sendExpressJson;
  if (typeof response.header === 'function') return sendFastifyJson;
  throw new TypeError('NestModelInterceptor requires an HTTP response with setHeader() or header().');
}

/** A writer that resolves the adapter at its first write and keeps it, so a stream that only forwards `null` or `undefined` needs no adapter method. */
function lazyJsonWriter(): JsonResponseWriter {
  let write: JsonResponseWriter = (response, text) => {
    write = jsonResponseWriter(response);
    return write(response, text);
  };
  return (response, text) => write(response, text);
}

function modelProjection(
  write: JsonResponseWriter,
  response: HttpResponse,
  codec: ObjectCodec,
  array: boolean,
): JsonModelProjection {
  return function projectModel(value): Observable<unknown> | Promise<unknown> {
    if (value === undefined) return FORWARDED_UNDEFINED;
    if (value === null) return FORWARDED_NULL;
    return write(response, stringifyModel(codec, value, array));
  };
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
  codec: ModelInput,
  construct: GeneratedModelConstructor | undefined,
  array: boolean,
  wire: unknown,
  decode: (wire: unknown) => unknown,
  field: string | undefined,
  maxDepth: number | undefined,
  validate: true | 'sanity' | undefined,
): unknown {
  const options = { failFast: true, construct, maxDepth, validate };
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

/** The options of a `NestModelInterceptor`. */
export interface NestModelInterceptorOptions {
  /**
   * How many levels of objects and arrays the body or query of a recursive model may nest; deeper input answers HTTP 400.
   * The default is 512. `Infinity` turns the bound off. A model that reaches no recursive model has no bound.
   */
  readonly maxDepth?: number;
  /**
   * The level the interceptor validates request input at. The default is the level of each model. `'sanity'` checks the
   * shape only; `true` checks everything. A level above the one the project generated fails the request with
   * `LibErrorKind.ValidationUnavailable`. Input that fails the check answers HTTP 400 at any level.
   */
  readonly validate?: true | 'sanity';
}

// #region nest-model-interceptor
export class NestModelInterceptor implements NestInterceptor {
  private readonly maxDepth: number;
  private readonly validate: true | 'sanity' | undefined;

  constructor(options: NestModelInterceptorOptions = {}) {
    this.maxDepth = resolveMaxDepth(options.maxDepth);
    // A JavaScript caller can pass `false`, `null` or a string; none may turn request validation off by accident (F-176).
    if (options.validate !== undefined && options.validate !== true && options.validate !== 'sanity') {
      throw new TypeError(`The validate option of NestModelInterceptor takes true or 'sanity'; got ${String(options.validate)}.`);
    }
    this.validate = options.validate;
  }

  private readonly writeJson = lazyJsonWriter();

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    // Body and query parameters are HTTP request input. An RPC or WebSocket handler has other parameters under the same numbers.
    if (context.getType() !== 'http') return next.handle();
    const handler = context.getHandler();
    const klass = context.getClass();
    // Inbound conversion only. Input that the model rejects becomes HTTP 400 (`httpError`). Any other error stays HTTP 500.
    try {
      const args = routeArgs(klass, handler.name);
      if (args) {
        const types = (reflectMeta().getMetadata('design:paramtypes', klass.prototype, handler.name) as unknown[] | undefined)
          ?? [];
        const req = context.switchToHttp().getRequest<HttpRequest>();
        // A whole parameter keys by its source, a one-field parameter by its source and field.
        let converted: Map<number | string, { codec: ModelInput; construct: GeneratedModelConstructor | undefined; array: boolean }> | undefined;
        // Bit 1 is the body, bit 2 the query.
        let wholeSources = 0;
        let fieldSources = 0;
        for (const [key, meta] of Object.entries(args)) {
          const colon = key.indexOf(':');
          const paramtype = Number(colon >= 0 ? key.slice(0, colon) : key);
          if (paramtype !== NEST_BODY && paramtype !== NEST_QUERY) continue;
          const field = typeof meta.data === 'string' && meta.data !== '' ? meta.data : undefined;
          const metatype = types[meta.index];
          const codec: ModelInput | undefined = boundUnion(metatype) ?? boundCodec(metatype);
          if (!codec) {
            // A controller declaration fault, not bad input: Nest answers 500 for this request.
            const where = `${inputDecorator(paramtype, field)} parameter ${meta.index} of ${klass.name}.${handler.name}`;
            const id = codecIdFromMetatype(metatype);
            const variantIds = asToken(metatype)?.[NEST_MODEL_UNION_IDS];
            const missing = variantIds?.filter((variant) => getObjectCodec(variant) === undefined).map((variant) => `"${variant}"`).join(' and ');
            throw new TypeError(id === undefined
              ? `NestModelInterceptor needs an IModel or IObject type for ${where}. Declare the input as an IModel or IObject. If it is a model, add extensions: { nest: {} } to the ts-openapi block in golem.yaml, so the build stamps the codec. Or write your own interceptor.`
              : `golem fault: NestModelInterceptor found no registered codec ${missing ?? `"${id}"`}${variantIds ? ` for the union "${id}"` : ''} for ${where}. The rewrite loads the generated module of the model, and that module did not load. Run golem generate and rewrite the file again.`);
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
            if (!sameInput(previous.codec, codec) || previous.construct !== construct || previous.array !== array) {
              throw new TypeError(field === undefined
                ? 'NestModelInterceptor requires one model type for each whole body or query object.'
                : `NestModelInterceptor requires one model type for ${inputDecorator(paramtype, field)} of ${klass.name}.${handler.name}.`);
            }
            continue;
          }
          const decode = paramtype === NEST_BODY ? NO_DECODE : queryWireDecoder(codec);
          // @Body() and @Query() read these values when next.handle() runs.
          if (field === undefined) {
            const value = convertInput(codec, construct, array, paramtype === NEST_BODY ? req.body : req.query, decode, undefined, this.maxDepth, this.validate);
            if (paramtype === NEST_BODY) req.body = value;
            else replaceQuery(req, value);
            wholeSources |= source;
          } else {
            const record = recordOrUndefined(paramtype === NEST_BODY ? req.body : req.query);
            const value = convertInput(codec, construct, array, record && Object.hasOwn(record, field) ? record[field] : undefined, decode, field, this.maxDepth, this.validate);
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
      const headers = nestHeadersCodec(klass, handler);
      if (headers) {
        const req = context.switchToHttp().getRequest<HttpRequest>();
        // Only the declared fields reach the handler; `request.headers` stays as received.
        const decoded = headers.decode(req.headers, { failFast: true, maxDepth: this.maxDepth, validate: this.validate });
        setNestHeaders(req, decoded);
      }
    } catch (error) {
      httpError(error);
    }
    const declared = nestReturnCodec(klass, handler);
    // A return without the golem mark stays plain Nest JSON.
    if (!declared) return next.handle();
    const response = context.switchToHttp().getResponse<HttpResponse>();
    const source = next.handle();
    const project = modelProjection(this.writeJson, response, declared.codec, declared.array);
    return mergeMap(project)(source);
  }
}
// #endregion nest-model-interceptor

export function nestModelStringifyInterceptor(codec: ObjectCodec): NestInterceptor {
  const writeJson = lazyJsonWriter();
  return {
    intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
      const response = context.switchToHttp().getResponse<HttpResponse>();
      const source = next.handle();
      return mergeMap((value: unknown): Observable<unknown> | Promise<unknown> => {
        if (value === undefined) return FORWARDED_UNDEFINED;
        if (value === null) return FORWARDED_NULL;
        return writeJson(response, stringifyModel(codec, value, Array.isArray(value)));
      })(source);
    },
  };
}
// #endregion nest-model-http
