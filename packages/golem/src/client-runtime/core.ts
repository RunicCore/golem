import { LibError, LibErrorKind } from '../errors.js';
import type { ValidationLevel } from '../object-codec.js';
import type { OperationRuntimeValidators } from '../schema-registry-validation.js';
import type { Validator } from '../validation-runtime.js';
import { mediaEssence, parseMediaType } from './media-type.js';
import { responseStatusKind } from './response-status.js';

export interface ParameterSerializerContext {
  readonly operation: string;
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie' | 'querystring';
  readonly contentType: string;
}
export type ParameterSerializer = (value: unknown, context: ParameterSerializerContext) => string;

export interface EncodedBody {
  body: BodyInit;
  /** Omit for FormData so the runtime supplies its multipart boundary. */
  contentType?: string;
}
export interface EncodingMetadata {
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly style?: string;
  readonly explode?: boolean;
  readonly allowReserved?: boolean;
  readonly encoding?: Readonly<Record<string, unknown>>;
  readonly prefixEncoding?: readonly unknown[];
  readonly itemEncoding?: unknown;
}
export interface BodyEncoderContext {
  readonly contentType: string;
  readonly encoding: Readonly<Record<string, EncodingMetadata>>;
  readonly prefixEncoding: readonly unknown[];
  readonly itemEncoding: unknown;
}
export type BodyEncoder = (value: unknown, context: BodyEncoderContext) => BodyInit | EncodedBody;

export interface MutualTlsTransport {
  readonly fetchImpl: typeof fetch;
}

export interface ResponseHeaderDecoderContext {
  readonly operation: string;
  readonly name: string;
  readonly contentType: string;
}
export type ResponseHeaderDecoder = (value: string, context: ResponseHeaderDecoderContext) => unknown;

export interface StreamDecoderContext {
  readonly operation: string;
  readonly contentType: string;
}
export type StreamDecoder = (response: Response, context: StreamDecoderContext) => AsyncIterable<unknown>;

export type ResponseDecoder = (response: Response) => unknown | Promise<unknown>;

/** A server of the OpenAPI document's `servers` list, as a generated client holds it. */
export interface ServerObject {
  readonly url: string;
  readonly description?: string;
  /** OpenAPI 3.2 `name`. */
  readonly name?: string;
  readonly variables?: Readonly<Record<string, { readonly default: string; readonly enum?: readonly string[] }>>;
}

export interface ClientOptions {
  /** The API endpoint. It wins over `server`. A client whose document lists no servers requires it. */
  baseUrl?: string;
  /**
   * The server to use from the document's `servers` list: its index, or its `name` or `description`. The default is the first server.
   * An operation or path item with its own `servers` list ignores it and uses that list's first server, with variable defaults.
   * Ignored when `baseUrl` is set; `baseUrl` wins over every list.
   */
  server?: number | string;
  /**
   * Values for the `{variables}` of the chosen server URL from the document's `servers` list. A variable you leave out uses its default.
   * An operation or path item server list always uses defaults.
   */
  serverVariables?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  headers?: HeadersInit;
  /** Credentials keyed by OpenAPI security-scheme name: values or lazy providers. */
  auth?: object;
  /**
   * Transport for a mutualTLS security scheme. When set, `mutualTls.fetchImpl`
   * replaces `fetchImpl` for every request from this client, not only for
   * operations that select a mutualTLS requirement. The application owns
   * certificate and agent configuration.
   */
  mutualTls?: MutualTlsTransport;
  /** Request codecs; configured codecs override built-in encoders. */
  bodyEncoders?: Record<string, BodyEncoder>;
  /** Response codecs; configured codecs override built-in readers. */
  responseDecoders?: Record<string, ResponseDecoder>;
  /** Parameter content serializers; configured serializers override built-ins. */
  parameterSerializers?: Record<string, ParameterSerializer>;
  /** Response header content decoders; configured decoders override built-ins. */
  responseHeaderDecoders?: Record<string, ResponseHeaderDecoder>;
  /**
   * Framing decoders for itemSchema streams other than built-in NDJSON,
   * JSON-seq, and SSE. Item schema checks follow the operation validators.
   */
  streamDecoders?: Record<string, StreamDecoder>;
  /** Overrides generated validators for individual operations. */
  operationValidators?: ReadonlyMap<string, OperationRuntimeValidators>;
  /** The default validation level of this client's calls; see `ValidateOption`. An SDK generated without validation has no such option. */
  validate?: ValidateOption;
}

/**
 * The validation level of a call: `true` checks everything, `'sanity'` checks the shape only, `false` checks nothing; conversion
 * runs at every level. A level alone sets `request` and `response`, the bodies and the path, query and cookie values; `requestHeaders`
 * and `responseHeaders` switch the header checks, each apart, and are off unless the option names them. An object sets the sides it names.
 * A side it leaves out takes the level of the next source: the call, then the client, then the SDK's own level (off for the headers).
 * A call can lower the level, never raise it above the SDK's: that throws `LibErrorKind.ValidationUnavailable`.
 */
export type ValidateOption = ValidationLevel | {
  readonly request?: ValidationLevel;
  readonly response?: ValidationLevel;
  readonly requestHeaders?: ValidationLevel;
  readonly responseHeaders?: ValidationLevel;
};

export interface RequestOptions {
  signal?: AbortSignal;
  /** The validation level of this call; it wins over the client's `validate`. */
  validate?: ValidateOption;
}

type ResponseFraming = 'ndjson' | 'json-seq' | 'sse' | 'custom-stream' | 'binary' | 'body';

interface RuntimeResponseHeaderContract {
  name: string;
  style: string;
  explode: boolean;
  contentType: string | null;
  /** The header is required: its absence is reported when response headers are checked. */
  required?: boolean;
  kind: string | null;
  itemKind: string | null;
  propertyKinds: Readonly<Record<string, string | null>>;
}

export interface RuntimeResponseContract {
  status: string;
  content: readonly {
    contentType: string;
    framing: ResponseFraming;
    requiredCodec?: string;
    schemaType?: string;
  }[];
  headers: readonly RuntimeResponseHeaderContract[];
}

interface RuntimeSecurityScheme {
  type?: string;
  scheme?: string;
  in?: string;
  name?: string;
  flows?: Readonly<Record<string, unknown>>;
  openIdConnectUrl?: string;
}
export type RuntimeSecuritySchemes = Readonly<Record<string, RuntimeSecurityScheme>>;

/** Turns one body between its plain and its wire form; a generated codec takes the type of its model, which the client has checked. */
type BodyConversion = (value: never, options?: { readonly validate: ValidationLevel }) => unknown;

/**
 * What the generated codec module of an operation holds: its validators, and the conversion of each body, parameter and response header
 * that has a Date or Temporal value. `responses` and `decode` are keyed `status:contentType`, `encode` by request content type,
 * `parameters` by `location:name` and `headers` by `status:name`; a value that converts nothing has no entry.
 */
export interface OperationCodecs {
  readonly input?: Validator;
  readonly requestHeaders?: Validator;
  readonly responses?: Readonly<Record<string, Validator>>;
  readonly responseHeaders?: Readonly<Record<string, Validator>>;
  readonly encode?: Readonly<Record<string, BodyConversion>>;
  readonly decode?: Readonly<Record<string, BodyConversion>>;
  readonly parameters?: Readonly<Record<string, BodyConversion>>;
  readonly headers?: Readonly<Record<string, BodyConversion>>;
}

/** The matched response a check runs against. */
interface CheckedResponse {
  readonly status: string;
  readonly contentType: string | null;
}

/** Checks a decoded response body or stream item, or the decoded value of the response header `header`; for a required header that is absent, `value` is undefined. Only SDKs generated with validation pass one, so the runtime core imports no validation code. */
export type ResponseCheck = (response: CheckedResponse, value: unknown, header?: string) => Promise<void>;

/** Converts a checked response body or stream item to its plain form, or the decoded value of the response header `header`; it runs after the check. */
export type ResponseDecode = (response: CheckedResponse, value: unknown, header?: string) => unknown;

/** A response whose status or media type the operation does not declare. Its body was cancelled. */
export interface UndeclaredResponseError extends LibError {
  readonly kind: LibErrorKind.Response;
  readonly client: string;
  readonly operation: string;
  readonly status: number;
  readonly headers: Headers;
  readonly contentType: string;
}

const undeclaredResponseBrand = Symbol('UndeclaredResponseError');

/** Without `client`, any client's undeclared-response error matches; with it, only that client's. */
export function isUndeclaredResponseError(error: unknown, client?: string): error is UndeclaredResponseError {
  return error instanceof LibError &&
    Object.hasOwn(error, undeclaredResponseBrand) &&
    (client === undefined || Reflect.get(error, 'client') === client);
}

function undeclaredResponseError(
  client: string,
  operation: string,
  response: Response,
  contentType: string,
): UndeclaredResponseError {
  const error = new LibError(
    LibErrorKind.Response,
    `Undeclared OpenAPI response for ${operation}: HTTP ${response.status} ${contentType || '(no content type)'}`,
    [],
    { causedByInput: true },
  );
  Object.defineProperty(error, undeclaredResponseBrand, { value: true });
  const undeclared = Object.assign(error, { client, operation, status: response.status, headers: response.headers, contentType });
  if (!isUndeclaredResponseError(undeclared)) throw new TypeError('undeclared response brand missing');
  return undeclared;
}

/** Exact media type, then its essence, then the wildcard entry. */
function lookupCodec<T>(map: Readonly<Record<string, T>>, keys: readonly string[]): T | undefined {
  for (const key of keys) {
    if (key && Object.hasOwn(map, key)) return map[key];
  }
  for (const key of keys) {
    const essence = mediaEssence(key);
    if (essence && Object.hasOwn(map, essence)) return map[essence];
  }
  return Object.hasOwn(map, '*/*') ? map['*/*'] : undefined;
}

/** How closely the media type `actual` (parameters ignored) matches the declared `expected`, which may be a range: 0 exact, 1 a subtype range, 2 the full range; null when it does not. */
function mediaRank(actual: string, expected: string): number | null {
  const { essence: range, type: rangeType, subtype: rangeSubtype } = parseMediaType(expected);
  const { essence: value, type: actualType } = parseMediaType(actual);
  if (value === range) return 0;
  if (rangeSubtype === '*' && rangeType === actualType) return 1;
  if (range === '*/*') return 2;
  return null;
}

interface SelectedResponse {
  status: string;
  contentType: string | null;
  actualContentType: string;
  framing: ResponseFraming;
  requiredCodec?: string;
  schemaType?: string;
  headers: readonly RuntimeResponseHeaderContract[];
}

async function* convertStreamItems(
  selected: CheckedResponse,
  stream: AsyncIterable<unknown>,
  check: ResponseCheck | undefined,
  decode: ResponseDecode | undefined,
): AsyncIterable<unknown> {
  for await (const item of stream) {
    if (check) await check(selected, item);
    yield decode ? decode(selected, item) : item;
  }
}

function serverBaseUrl(client: string, options: ClientOptions, servers: readonly ServerObject[]): string {
  if (options.baseUrl !== undefined) {
    const baseUrl = options.baseUrl.trim();
    if (!baseUrl) throw new Error(`${client}Client requires a non-empty baseUrl`);
    return baseUrl;
  }
  const { server = 0, serverVariables = {} } = options;
  const named = servers.findIndex((entry) => entry.name === server);
  const picked = servers[typeof server === 'number' ? server : named >= 0 ? named : servers.findIndex((entry) => entry.description === server)];
  if (!picked) {
    throw new Error(servers.length
      ? `${client}Client found no server ${JSON.stringify(server)} in the document; it lists ${servers.length}`
      : `${client}Client requires a non-empty baseUrl`);
  }
  return fillServerUrl(client, picked, server, serverVariables);
}

/** The URL of `server` with its `{variables}` filled from `serverVariables`, else their defaults. `choice` names the server in errors. */
function fillServerUrl(client: string, server: ServerObject, choice: number | string, serverVariables: Readonly<Record<string, string>>): string {
  const declared = server.variables ?? {};
  for (const name of Object.keys(serverVariables)) {
    if (!Object.hasOwn(declared, name)) {
      throw new Error(`${client}Client server ${JSON.stringify(choice)} declares no variable ${JSON.stringify(name)}`);
    }
  }
  return server.url.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
    if (!Object.hasOwn(declared, name)) return placeholder;
    const variable = declared[name]!;
    const value = Object.hasOwn(serverVariables, name) ? serverVariables[name]! : variable.default;
    if (variable.enum && !variable.enum.includes(value)) {
      throw new Error(`${client}Client server variable ${JSON.stringify(name)} must be one of ${variable.enum.join(', ')}; got ${JSON.stringify(value)}`);
    }
    return value;
  });
}

// Reads a byte stream as records: `split` cuts text into records, the
// unfinished one last, and sees each character once (plus one held back); `parse` turns a record into an item or
// `undefined`, and sees the unfinished tail once more with `atEnd` set. The
// reader is cancelled when the consumer stops early or a record fails.
async function* readRecords<T>(
  stream: ReadableStream<Uint8Array>,
  ignoreBOM: boolean,
  split: (buffered: string) => string[],
  parse: (record: string, atEnd: boolean) => T | undefined,
): AsyncIterable<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder(undefined, { fatal: true, ignoreBOM });
  // The unfinished record is kept as pieces, so a chunk is cut once: `last` is its final character
  // (a delimiter of two characters, such as CRLF, may start there) and `pieces` hold the rest.
  let pieces: string[] = [];
  let last = '';
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      const records = split(last + decoder.decode(result.value, { stream: true }));
      const rest = records.pop() || '';
      if (records.length) {
        records[0] = pieces.join('') + records[0];
        pieces = [rest.slice(0, -1)];
      } else {
        pieces.push(rest.slice(0, -1));
      }
      last = rest.slice(-1);
      for (const record of records) {
        const parsed = parse(record, false);
        if (parsed !== undefined) yield parsed;
      }
    }
    const parsed = parse(pieces.join('') + last + decoder.decode(), true);
    if (parsed !== undefined) yield parsed;
  } catch (error) {
    completed = false;
    throw error;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class ClientRuntime {
  public readonly baseUrl: string;
  public readonly fetchImpl: typeof fetch;
  public readonly defaultHeaders: Headers;
  private readonly responseDecoders: Record<string, ResponseDecoder>;
  private readonly responseHeaderDecoders: Record<string, ResponseHeaderDecoder>;
  private readonly streamDecoders: Record<string, StreamDecoder>;
  /** @internal Read by `operationValidators` in `validation.ts`. */
  public readonly operationValidatorOverrides: ReadonlyMap<string, OperationRuntimeValidators> | undefined;
  /** @internal Read by `operationValidators` in `validation.ts`. */
  public readonly operationValidatorCache = new Map<string, OperationRuntimeValidators>();

  /** `options` stays readable so request-side helpers can read the settings they own. */
  constructor(
    public readonly client: string,
    public readonly options: ClientOptions,
    servers: readonly ServerObject[] = [],
  ) {
    this.baseUrl = serverBaseUrl(client, options, servers).replace(/\/$/, '');
    const configuredFetch = options.mutualTls?.fetchImpl ?? options.fetchImpl;
    // Call a configured fetch without a receiver: browsers reject a native
    // fetch invoked with any receiver other than the global object.
    this.fetchImpl = configuredFetch
      ? (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => configuredFetch(input, init)
      : fetch.bind(globalThis);
    this.defaultHeaders = new Headers(options.headers);
    this.responseDecoders = options.responseDecoders ?? {};
    this.responseHeaderDecoders = options.responseHeaderDecoders ?? {};
    this.streamDecoders = options.streamDecoders ?? {};
    this.operationValidatorOverrides = options.operationValidators;
  }

  /** `server` is the first server of an operation whose own `servers` replace the document's; `baseUrl` still wins over it. */
  public url(route: string, query: readonly string[], server?: ServerObject): string {
    const suffix = query.length ? `?${query.join('&')}` : '';
    const baseUrl = this.options.baseUrl === undefined && server ? fillServerUrl(this.client, server, 0, {}).replace(/\/$/, '') : this.baseUrl;
    return `${baseUrl}${route}${suffix}`;
  }

  private matchesStatus(status: number, expected: string): boolean {
    switch (responseStatusKind(expected)) {
      case 'status': return status === Number(expected);
      case 'range': return String(status)[0] === expected[0];
      case 'default': return true;
      default: return false;
    }
  }

  private selectResponse(
    operation: string,
    response: Response,
    contracts: readonly RuntimeResponseContract[],
  ): SelectedResponse {
    const rawMediaType = response.headers.get('content-type') || '';
    const mediaType = mediaEssence(rawMediaType);
    let selected: (typeof contracts)[number] | undefined;
    let range: (typeof contracts)[number] | undefined;
    let fallback: (typeof contracts)[number] | undefined;
    for (const contract of contracts) {
      const kind = responseStatusKind(contract.status);
      if (kind === 'status' && this.matchesStatus(response.status, contract.status)) {
        selected = contract;
        break;
      }
      if (!range && kind === 'range' && this.matchesStatus(response.status, contract.status)) range = contract;
      if (!fallback && kind === 'default') fallback = contract;
    }
    selected ??= range ?? fallback;
    if (!selected) throw undeclaredResponseError(this.client, operation, response, mediaType);
    // A response declared without content has no body to read, whatever the server sends.
    if (!selected.content.length) {
      return {
        status: selected.status,
        contentType: null,
        actualContentType: mediaType,
        framing: 'body',
        headers: selected.headers,
      };
    }
    let match: (typeof selected.content)[number] | undefined;
    let bestRank = Infinity;
    for (const item of selected.content) {
      const rank = mediaRank(mediaType, item.contentType);
      if (rank !== null && rank < bestRank) {
        match = item;
        bestRank = rank;
        if (rank === 0) break;
      }
    }
    if (!match) throw undeclaredResponseError(this.client, operation, response, mediaType);
    return {
      ...match,
      status: selected.status,
      actualContentType: mediaType,
      headers: selected.headers,
    };
  }

  private decodeHeaderScalar(value: string, kind: string | null): unknown {
    if (kind === 'integer' || kind === 'number') {
      const jsonNumber = kind === 'integer' ? /^-?(?:0|[1-9]\d*)$/ : /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
      const number = Number(value);
      if (!jsonNumber.test(value) || !Number.isFinite(number)) throw new TypeError(`Invalid numeric response header: ${value}`);
      return number;
    }
    if (kind === 'boolean') {
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new TypeError(`Invalid boolean response header: ${value}`);
    }
    if (kind === 'null') {
      if (value === 'null') return null;
      throw new TypeError(`Invalid null response header: ${value}`);
    }
    return value;
  }

  private decodeResponseHeader(
    operation: string,
    value: string,
    metadata: Omit<RuntimeResponseHeaderContract, 'style'>,
  ): unknown {
    if (metadata.contentType) {
      const normalized = metadata.contentType.toLowerCase();
      const decoder =
        this.responseHeaderDecoders[normalized] ?? this.responseHeaderDecoders['*/*'];
      if (decoder) return decoder(value, { operation, name: metadata.name, contentType: metadata.contentType });
      if (normalized.includes('json')) return JSON.parse(value);
      if (normalized === 'application/x-www-form-urlencoded') {
        return Object.fromEntries(new URLSearchParams(value));
      }
      if (normalized.startsWith('text/')) return value;
      throw new Error(
        `No response header decoder configured for media type: ${metadata.contentType}`,
      );
    }
    const trimOws = (token: string): string => token.replace(/^[ \t]+|[ \t]+$/g, '');
    if (metadata.kind === 'array') {
      // An empty value is the empty array; split would give one empty item.
      if (trimOws(value) === '') return [];
      return value.split(',').map((item) => this.decodeHeaderScalar(trimOws(item), metadata.itemKind));
    }
    if (metadata.kind === 'object') {
      // An empty map is undefined in RFC 6570 (section 2.3) and simple expansion writes nothing for it, so an empty value is {}.
      if (trimOws(value) === '') return {};
      const parts = value.split(',');
      const entries: Array<[string, unknown]> = [];
      if (metadata.explode) {
        for (const part of parts) {
          const separator = part.indexOf('=');
          if (separator < 0) throw new TypeError(`Invalid exploded object response header: ${value}`);
          const name = trimOws(part.slice(0, separator));
          entries.push([
            name,
            this.decodeHeaderScalar(trimOws(part.slice(separator + 1)), Object.hasOwn(metadata.propertyKinds, name) ? metadata.propertyKinds[name] : null),
          ]);
        }
      } else {
        if (parts.length % 2 !== 0) throw new TypeError(`Invalid object response header: ${value}`);
        for (let index = 0; index < parts.length; index += 2) {
          const name = trimOws(parts[index]);
          entries.push([
            name,
            this.decodeHeaderScalar(trimOws(parts[index + 1]), Object.hasOwn(metadata.propertyKinds, name) ? metadata.propertyKinds[name] : null),
          ]);
        }
      }
      return Object.fromEntries(entries);
    }
    return this.decodeHeaderScalar(value, metadata.kind);
  }

  private async responseHeaders(
    operation: string,
    response: Response,
    headers: readonly RuntimeResponseHeaderContract[],
    checked: CheckedResponse,
    check: ResponseCheck | undefined,
    decode: ResponseDecode | undefined,
  ): Promise<Record<string, unknown>> {
    const entries: Array<[string, unknown]> = [];
    for (const metadata of headers) {
      const value = response.headers.get(metadata.name);
      if (value !== null) {
        const decoded = this.decodeResponseHeader(operation, value, metadata);
        if (check) await check(checked, decoded, metadata.name);
        entries.push([metadata.name, decode ? decode(checked, decoded, metadata.name) : decoded]);
      } else if (metadata.required && check) await check(checked, undefined, metadata.name);
    }
    return Object.fromEntries(entries);
  }

  private async httpResponse(
    operation: string,
    response: Response,
    declaredStatus: string,
    contentType: string | null,
    body: unknown,
    contracts: readonly RuntimeResponseContract[],
    check: ResponseCheck | undefined,
    decode: ResponseDecode | undefined,
  ): Promise<{
    matched: 'status' | 'range' | 'default';
    status: number;
    contentType: string | null;
    body: unknown;
    headers: Record<string, unknown>;
  }> {
    const contract = contracts.find((item) => item.status === declaredStatus);
    if (!contract) throw new Error(`Missing generated response contract for ${operation} ${declaredStatus}`);
    return {
      matched: responseStatusKind(declaredStatus) ?? 'status',
      status: response.status,
      contentType,
      body,
      headers: await this.responseHeaders(operation, response, contract.headers, { status: declaredStatus, contentType }, check, decode),
    };
  }

  public async readResponse<TResponse>(
    operation: string,
    response: Response,
    contracts: readonly RuntimeResponseContract[],
    check?: ResponseCheck,
    decode?: ResponseDecode,
  ): Promise<TResponse> {
    try {
      const selected = this.selectResponse(operation, response, contracts);
      const rawContentType = response.headers.get('content-type') || '';
      if (selected.framing === 'ndjson' || selected.framing === 'json-seq' || selected.framing === 'sse' || selected.framing === 'custom-stream') {
        if (!response.body) throw new Error('Streaming response has no body');
        const customStream = lookupCodec(this.streamDecoders, [rawContentType, selected.contentType || '']);
        if (customStream) {
          const framed = customStream(response, { operation, contentType: selected.actualContentType });
          return await this.httpResponse(operation, response, selected.status, selected.contentType, check || decode ? convertStreamItems(selected, framed, check, decode) : framed, contracts, check, decode) as TResponse;
        }
        const framed = selected.framing === 'ndjson' ? this.readNdjson(response.body)
          : selected.framing === 'json-seq' ? this.readJsonSeq(response.body)
          : selected.framing === 'sse' ? this.readServerSentEvents(response.body)
          : (() => { throw new Error('No stream decoder configured for media type: ' + (selected.contentType || '')); })();
        const body = check || decode ? convertStreamItems(selected, framed, check, decode) : framed;
        return await this.httpResponse(operation, response, selected.status, selected.contentType, body, contracts, check, decode) as TResponse;
      }
      const mediaType = selected.actualContentType;
      const customDecoder = lookupCodec(this.responseDecoders, [rawContentType, selected.contentType || '']);
      let body: unknown;
      if (selected.contentType === null) await response.body?.cancel().catch(() => undefined);
      else if (customDecoder) body = await customDecoder(response);
      else if (selected.requiredCodec) {
        throw new Error(
          `Custom ${selected.requiredCodec} required for operation ${operation} status ${selected.status} media ${selected.contentType || rawContentType} type ${selected.schemaType || 'ambiguous'}`,
        );
      }
      else if (mediaType.includes('json')) {
        const text = await response.text();
        body = !text ? undefined : JSON.parse(text);
      }
      else if (/^(application\/octet-stream|application\/pdf|application\/zip|application\/x-zip-compressed|application\/gzip|image\/|audio\/|video\/|font\/)/i.test(mediaType)) {
        body = await response.blob();
      }
      else if (mediaType.startsWith('text/') && !/xml|yaml|yml/i.test(mediaType) && mediaType !== 'text/event-stream') {
        body = await response.text();
      }
      else {
        throw new Error(`No response decoder configured for media type: ${mediaType || '(empty)'}`);
      }
      if (check) await check(selected, body);
      if (decode && selected.contentType !== null) body = decode(selected, body);
      return await this.httpResponse(operation, response, selected.status, selected.contentType, body, contracts, check, decode) as TResponse;
    }
    catch (error) {
      if (response.body && !response.body.locked) {
        try { await response.body.cancel(error); }
        catch { /* Preserve the original protocol or decoder failure. */ }
      }
      throw error;
    }
  }

  private readNdjson<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    return readRecords<T>(stream, false, (buffered) => buffered.split(/\r?\n/), (line) => {
      const value = line.trim();
      if (!value) return undefined;
      try {
        return JSON.parse(value) as T;
      } catch (error) {
        throw new Error(`Malformed NDJSON record: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  private readJsonSeq<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    let sawRecordSeparator = false;
    return readRecords<T>(stream, true, (buffered) => buffered.split('\u001e'), (record, atEnd) => {
      if (!sawRecordSeparator) {
        if (record.length > 0) throw new Error('JSON text sequence requires an RS before the first record');
        sawRecordSeparator = !atEnd;
        return undefined;
      }
      if (!record.trim()) return undefined;
      try {
        const parsed = JSON.parse(record) as T;
        if ((parsed === null || typeof parsed !== 'object') && !/\s$/u.test(record)) {
          throw new Error('JSON text sequence primitive must end with JSON whitespace');
        }
        return parsed;
      } catch (error) {
        throw new Error(`Malformed JSON text sequence record: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  private readServerSentEvents<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    let event = '';
    let id = '';
    let retry: number | undefined;
    let data: string[] = [];
    const emit = (): T | undefined => {
      // WHATWG: a blank line without data discards the event type; the last
      // event id and a pending retry are stream state and carry over.
      if (!data.length) {
        event = '';
        return undefined;
      }
      const value: Record<string, unknown> = { data: data.join('\n') };
      if (event) value.event = event;
      if (id) value.id = id;
      // A retry too large for a double is Infinity, which JSON writes as null.
      if (retry !== undefined) value.retry = Number.isFinite(retry) ? retry : null;
      event = '';
      data = [];
      retry = undefined;
      return value as T;
    };
    const consume = (line: string): T | undefined => {
      if (line === '') return emit();
      if (line.startsWith(':')) return undefined;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? '' : line.slice(separator + 1);
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id' && !value.includes('\0')) id = value;
      else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
      return undefined;
    };
    return readRecords<T>(stream, false, (buffered) => {
      // A trailing CR may be the first half of a CRLF split across chunks.
      if (!buffered.endsWith('\r')) return buffered.split(/\r\n|\r|\n/);
      const lines = buffered.slice(0, -1).split(/\r\n|\r|\n/);
      lines.push(lines.pop() + '\r');
      return lines;
    }, (line, atEnd) => {
      // At EOF a CR still ends its line; an unterminated line and an event
      // without its blank line are incomplete and are discarded.
      if (!atEnd) return consume(line);
      return line.endsWith('\r') ? consume(line.slice(0, -1)) : undefined;
    });
  }
}
