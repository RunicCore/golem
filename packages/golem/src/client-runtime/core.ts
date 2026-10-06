import { LibError, LibErrorKind } from '../errors.js';
import type { OperationRuntimeValidators } from '../schema-registry-validation.js';
import type { Validator } from '../validation-runtime.js';

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

export interface ClientOptions {
  /** Runtime-owned API endpoint. No specification server URL is assumed. */
  baseUrl: string;
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
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export type ResponseFraming = 'ndjson' | 'json-seq' | 'sse' | 'custom-stream' | 'binary' | 'body';

export interface RuntimeResponseHeaderContract {
  name: string;
  style: string;
  explode: boolean;
  contentType: string | null;
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

export interface RuntimeSecurityScheme {
  type?: string;
  scheme?: string;
  in?: string;
  name?: string;
  flows?: Readonly<Record<string, unknown>>;
  openIdConnectUrl?: string;
}
export type RuntimeSecuritySchemes = Readonly<Record<string, RuntimeSecurityScheme>>;

export interface OperationValidationSources {
  readonly inputReference: string;
  readonly responseReferences: readonly { readonly status: string; readonly contentType: string; readonly reference: string }[];
  /** The operation's generated validators, keyed by the references above. */
  readonly validators: Readonly<Record<string, Validator>>;
}

/** The matched response a check runs against. */
export interface CheckedResponse {
  readonly status: string;
  readonly contentType: string | null;
}

/** Checks a decoded response body or stream item. Only SDKs generated with validation pass one, so the runtime core imports no validation code. */
export type ResponseCheck = (response: CheckedResponse, value: unknown) => Promise<void>;

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
    const essence = (key.split(';', 1)[0] || '').trim().toLowerCase();
    if (essence && Object.hasOwn(map, essence)) return map[essence];
  }
  return Object.hasOwn(map, '*/*') ? map['*/*'] : undefined;
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

async function* checkStreamItems(
  selected: CheckedResponse,
  stream: AsyncIterable<unknown>,
  check: ResponseCheck,
): AsyncIterable<unknown> {
  for await (const item of stream) {
    await check(selected, item);
    yield item;
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
  ) {
    const baseUrl = options.baseUrl.trim();
    if (!baseUrl) throw new Error(`${client}Client requires a non-empty baseUrl`);
    this.baseUrl = baseUrl.replace(/\/$/, '');
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

  public url(route: string, query: readonly string[]): string {
    const suffix = query.length ? `?${query.join('&')}` : '';
    return `${this.baseUrl}${route}${suffix}`;
  }

  private matchesStatus(status: number, expected: string): boolean {
    if (/^\d{3}$/.test(expected)) return status === Number(expected);
    if (/^[1-5]XX$/i.test(expected)) return String(status)[0] === expected[0];
    return expected === 'default';
  }

  private mediaRank(actual: string, expected: string): number | null {
    const rangeEnd = expected.indexOf(';');
    const valueEnd = actual.indexOf(';');
    const range = (rangeEnd < 0 ? expected : expected.slice(0, rangeEnd)).trim().toLowerCase();
    const value = (valueEnd < 0 ? actual : actual.slice(0, valueEnd)).trim().toLowerCase();
    if (value === range) return 0;
    const [rangeType, rangeSubtype] = range.split('/');
    const [actualType] = value.split('/');
    if (rangeSubtype === '*' && rangeType === actualType) return 1;
    if (range === '*/*') return 2;
    return null;
  }

  private selectResponse(
    operation: string,
    response: Response,
    contracts: readonly RuntimeResponseContract[],
  ): SelectedResponse {
    const rawMediaType = response.headers.get('content-type') || '';
    const mediaEnd = rawMediaType.indexOf(';');
    const mediaType = (mediaEnd < 0 ? rawMediaType : rawMediaType.slice(0, mediaEnd)).trim().toLowerCase();
    let selected: (typeof contracts)[number] | undefined;
    let range: (typeof contracts)[number] | undefined;
    let fallback: (typeof contracts)[number] | undefined;
    for (const contract of contracts) {
      if (/^\d{3}$/.test(contract.status) && this.matchesStatus(response.status, contract.status)) {
        selected = contract;
        break;
      }
      if (!range && /^[1-5]XX$/i.test(contract.status) && this.matchesStatus(response.status, contract.status)) range = contract;
      if (!fallback && contract.status === 'default') fallback = contract;
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
      const rank = this.mediaRank(mediaType, item.contentType);
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
      const number = Number(value);
      if (!Number.isFinite(number)) throw new TypeError(`Invalid numeric response header: ${value}`);
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
      return value.split(',').map((item) => this.decodeHeaderScalar(trimOws(item), metadata.itemKind));
    }
    if (metadata.kind === 'object') {
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

  private responseHeaders(
    operation: string,
    response: Response,
    headers: readonly RuntimeResponseHeaderContract[],
  ): Record<string, unknown> {
    const entries: Array<[string, unknown]> = [];
    for (const metadata of headers) {
      const value = response.headers.get(metadata.name);
      if (value !== null) {
        entries.push([metadata.name, this.decodeResponseHeader(operation, value, metadata)]);
      }
    }
    return Object.fromEntries(entries);
  }

  private httpResponse(
    operation: string,
    response: Response,
    declaredStatus: string,
    contentType: string | null,
    body: unknown,
    contracts: readonly RuntimeResponseContract[],
  ): {
    matched: 'status' | 'range' | 'default';
    status: number;
    contentType: string | null;
    body: unknown;
    headers: Record<string, unknown>;
  } {
    const contract = contracts.find((item) => item.status === declaredStatus);
    if (!contract) throw new Error(`Missing generated response contract for ${operation} ${declaredStatus}`);
    return {
      matched: declaredStatus === 'default' ? 'default' : /^[1-5]XX$/i.test(declaredStatus) ? 'range' : 'status',
      status: response.status,
      contentType,
      body,
      headers: this.responseHeaders(operation, response, contract.headers),
    };
  }

  public async readResponse<TResponse>(
    operation: string,
    response: Response,
    contracts: readonly RuntimeResponseContract[],
    check?: ResponseCheck,
  ): Promise<TResponse> {
    try {
      const selected = this.selectResponse(operation, response, contracts);
      const rawContentType = response.headers.get('content-type') || '';
      if (selected.framing === 'ndjson' || selected.framing === 'json-seq' || selected.framing === 'sse' || selected.framing === 'custom-stream') {
        if (!response.body) throw new Error('Streaming response has no body');
        const customStream = lookupCodec(this.streamDecoders, [rawContentType, selected.contentType || '']);
        if (customStream) {
          const framed = customStream(response, { operation, contentType: selected.actualContentType });
          return this.httpResponse(operation, response, selected.status, selected.contentType, check ? checkStreamItems(selected, framed, check) : framed, contracts) as TResponse;
        }
        const framed = selected.framing === 'ndjson' ? this.readNdjson(response.body)
          : selected.framing === 'json-seq' ? this.readJsonSeq(response.body)
          : selected.framing === 'sse' ? this.readServerSentEvents(response.body)
          : (() => { throw new Error('No stream decoder configured for media type: ' + (selected.contentType || '')); })();
        const body = check ? checkStreamItems(selected, framed, check) : framed;
        return this.httpResponse(operation, response, selected.status, selected.contentType, body, contracts) as TResponse;
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
      return this.httpResponse(operation, response, selected.status, selected.contentType, body, contracts) as TResponse;
    }
    catch (error) {
      if (response.body && !response.body.locked) {
        try { await response.body.cancel(error); }
        catch { /* Preserve the original protocol or decoder failure. */ }
      }
      throw error;
    }
  }

  private async *readNdjson<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    const reader = stream.getReader();
    const decoder = new TextDecoder(undefined, { fatal: true });
    let buffered = '';
    let completed = false;
    const parseLine = (line: string): T | undefined => {
      const value = line.trim();
      if (!value) return undefined;
      try {
        return JSON.parse(value) as T;
      } catch (error) {
        throw new Error(`Malformed NDJSON record: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          completed = true;
          break;
        }
        buffered += decoder.decode(result.value, { stream: true });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseLine(line);
          if (parsed !== undefined) yield parsed;
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) {
        const parsed = parseLine(buffered);
        if (parsed !== undefined) yield parsed;
      }
    } catch (error) {
      completed = false;
      throw error;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  private async *readJsonSeq<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    const reader = stream.getReader();
    const decoder = new TextDecoder(undefined, { fatal: true, ignoreBOM: true });
    let buffered = '';
    let sawRecordSeparator = false;
    let completed = false;
    const parseRecord = (record: string): T | undefined => {
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
    };
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          completed = true;
          break;
        }
        buffered += decoder.decode(result.value, { stream: true });
        const records = buffered.split('\u001e');
        buffered = records.pop() || '';
        for (const record of records) {
          if (!sawRecordSeparator) {
            if (record.length > 0) throw new Error('JSON text sequence requires an RS before the first record');
            sawRecordSeparator = true;
            continue;
          }
          const parsed = parseRecord(record);
          if (parsed !== undefined) yield parsed;
        }
      }
      buffered += decoder.decode();
      if (!sawRecordSeparator) {
        if (buffered.length > 0) throw new Error('JSON text sequence requires an RS before the first record');
      } else if (buffered.trim()) {
        const parsed = parseRecord(buffered);
        if (parsed !== undefined) yield parsed;
      }
    } catch (error) {
      completed = false;
      throw error;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  private async *readServerSentEvents<T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    const reader = stream.getReader();
    const decoder = new TextDecoder(undefined, { fatal: true });
    let buffered = '';
    let event = '';
    let id = '';
    let retry: number | undefined;
    let data: string[] = [];
    let completed = false;
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
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          completed = true;
          break;
        }
        buffered += decoder.decode(result.value, { stream: true });
        // A trailing CR may be the first half of a CRLF split across chunks.
        const heldCarriageReturn = buffered.endsWith('\r');
        const lines = (heldCarriageReturn ? buffered.slice(0, -1) : buffered).split(/\r\n|\r|\n/);
        buffered = (lines.pop() || '') + (heldCarriageReturn ? '\r' : '');
        for (const line of lines) {
          const value = consume(line);
          if (value !== undefined) yield value;
        }
      }
      buffered += decoder.decode();
      // At EOF a CR still ends its line; an unterminated line and an event
      // without its blank line are incomplete and are discarded.
      if (buffered.endsWith('\r')) {
        const value = consume(buffered.slice(0, -1));
        if (value !== undefined) yield value;
      }
    } catch (error) {
      completed = false;
      throw error;
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
