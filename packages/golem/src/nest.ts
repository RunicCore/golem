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
 * models. `nestModelStringifyInterceptor` stays for a response whose codec is
 * not the declared return type.
 */
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { mergeMap, type Observable } from 'rxjs';
import { IssueRepresentation, IssueSource, LibError, LibErrorKind, type IssuePath } from './errors.js';
import { resolveMaxDepth } from './conversion.js';
import { getIModelClass, getObjectCodec, type ObjectCodec } from './object-codec.js';
import {
  asToken,
  boundArray,
  boundCodec,
  boundConstruct,
  boundUnion,
  codecIdFromMetatype,
  NEST_MODEL_RETURN,
  NEST_MODEL_UNION_IDS,
  queryWireDecoder,
  reflectMeta,
  schemaRecord,
  type ModelInput,
  type NestModelConstruct,
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
  construct: NestModelConstruct | undefined,
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
        let converted: Map<number | string, { codec: ModelInput; construct: NestModelConstruct | undefined; array: boolean }> | undefined;
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
              ? `NestModelInterceptor needs an IModel or IObject type for ${where}. Declare the input as an IModel or IObject, or write your own interceptor.`
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
            const record = schemaRecord(paramtype === NEST_BODY ? req.body : req.query);
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
