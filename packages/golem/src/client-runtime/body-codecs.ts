import { LibError } from '../errors.js';
import type { ValidationLevel } from '../object-codec.js';
import type { BodyEncoder, ClientRuntime, EncodedBody, EncodingMetadata, OperationCodecs, ResponseCheck, ResponseDecode } from './core.js';
import { addQueryParameter } from './parameters.js';
import type { CallLevels } from './validation.js';

/** Encoding metadata the generated operation declares for one request media type. */
interface RequestMediaMetadata {
  readonly encoding: Readonly<Record<string, EncodingMetadata>>;
  readonly prefixEncoding: readonly unknown[];
  readonly itemEncoding: unknown;
  readonly requiredCodec?: string;
  readonly schemaType?: string;
}

function isEncodedBody(value: BodyInit | EncodedBody): value is EncodedBody {
  return typeof value === 'object' &&
    value !== null &&
    'body' in value &&
    !(value instanceof Blob) &&
    !(value instanceof FormData) &&
    !(value instanceof URLSearchParams) &&
    !(value instanceof ArrayBuffer);
}

/** The Encoding Object of a body key, from own keys only: a key such as `constructor` must not find Object.prototype. */
function ownEncoding(encoding: Readonly<Record<string, EncodingMetadata>>, name: string): EncodingMetadata | undefined {
  return Object.hasOwn(encoding, name) ? encoding[name] : undefined;
}

function findBodyEncoder(encoders: Record<string, BodyEncoder>, contentType: string): BodyEncoder | undefined {
  if (Object.hasOwn(encoders, contentType)) return encoders[contentType];
  const essence = (contentType.split(';', 1)[0] || '').trim().toLowerCase();
  if (essence && Object.hasOwn(encoders, essence)) return encoders[essence];
  return Object.hasOwn(encoders, '*/*') ? encoders['*/*'] : undefined;
}

export function encodeBody(
  runtime: ClientRuntime,
  operation: string,
  value: unknown,
  contentType: string | undefined,
  mediaMetadata: Readonly<Record<string, RequestMediaMetadata>>,
): { body?: BodyInit; contentType?: string } {
  if (value === undefined || !contentType) return {};
  const essence = (contentType.split(';', 1)[0] || '').trim().toLowerCase();
  const metadata: RequestMediaMetadata = mediaMetadata[contentType] || mediaMetadata[essence] || {
    encoding: {},
    prefixEncoding: [],
    itemEncoding: null,
  };
  const customEncoder = findBodyEncoder(runtime.options.bodyEncoders ?? {}, contentType);
  if (customEncoder) {
    const encoded = customEncoder(value, { contentType, ...metadata });
    if (isEncodedBody(encoded)) return encoded;
    return encoded instanceof FormData ? { body: encoded } : { body: encoded, contentType };
  }
  if (metadata.requiredCodec) {
    throw new Error(
      `Custom ${metadata.requiredCodec} required for operation ${operation} media ${contentType} type ${metadata.schemaType || 'ambiguous'}`,
    );
  }
  if (essence.includes('json')) {
    return { body: JSON.stringify(value), contentType };
  }
  if (essence === 'application/x-www-form-urlencoded') {
    const advancedEncoding = metadata.prefixEncoding.length > 0 ||
      metadata.itemEncoding !== null ||
      Object.values(metadata.encoding).some((item) =>
        item.contentType !== undefined ||
        item.headers !== undefined ||
        item.encoding !== undefined ||
        item.prefixEncoding !== undefined ||
        item.itemEncoding !== undefined
      );
    if (advancedEncoding) {
      throw new Error(
        `Form media type ${contentType} requires a custom body encoder for nested or content-specific Encoding Objects`,
      );
    }
    const fields: string[] = [];
    if (typeof value === 'object' && value !== null) {
      for (const [name, item] of Object.entries(value)) {
        const itemEncoding = ownEncoding(metadata.encoding, name) || {};
        addQueryParameter(
          runtime,
          fields,
          name,
          item,
          itemEncoding.style || 'form',
          itemEncoding.explode === undefined ? true : itemEncoding.explode,
          itemEncoding.allowReserved === true,
        );
      }
    }
    return { body: fields.join('&'), contentType };
  }
  if (essence === 'multipart/form-data') {
    const advancedEncoding = metadata.prefixEncoding.length > 0 ||
      metadata.itemEncoding !== null ||
      Object.values(metadata.encoding).some((item) =>
        item.headers !== undefined ||
        item.style !== undefined ||
        item.explode !== undefined ||
        item.allowReserved !== undefined ||
        item.encoding !== undefined ||
        item.prefixEncoding !== undefined ||
        item.itemEncoding !== undefined
      );
    if (advancedEncoding) {
      throw new Error(
        `Multipart media type ${contentType} requires a custom body encoder for advanced Encoding Object fields`,
      );
    }
    const form = new FormData();
    const encoding = metadata.encoding;
    if (typeof value === 'object' && value !== null) {
      for (const [name, item] of Object.entries(value)) {
        const values = Array.isArray(item) ? item : [item];
        for (const entry of values) {
          if (entry === undefined) continue;
          const partType = ownEncoding(encoding, name)?.contentType;
          // A null is written only in a JSON part, as `null`; a text part has no form for it, as a form-urlencoded body has none.
          if (entry === null && !partType?.toLowerCase().includes('json')) continue;
          if (entry instanceof Blob) form.append(name, entry);
          else if (partType) {
            const serialized = typeof entry === 'object' && entry !== null ? JSON.stringify(entry) : String(entry);
            form.append(name, new Blob([serialized], { type: partType }));
          }
          else if (typeof entry === 'object' && entry !== null) {
            form.append(name, new Blob([JSON.stringify(entry)], { type: 'application/json' }));
          }
          else form.append(name, String(entry));
        }
      }
    }
    return { body: form };
  }
  if (value instanceof Blob || value instanceof FormData || value instanceof URLSearchParams || typeof value === 'string') {
    return { body: value, contentType };
  }
  throw new Error(`No request body encoder configured for media type: ${contentType}`);
}

/**
 * The request body in its wire form: the generated encoder of its media type converts it, and a body that converts nothing has none.
 * The encoder checks the plain value at `validate`; conversion runs at every level.
 */
export function convertRequestBody(codecs: OperationCodecs, contentType: string | undefined, value: unknown, validate?: ValidationLevel): unknown {
  const encode = value === undefined || contentType === undefined || !codecs.encode || !Object.hasOwn(codecs.encode, contentType) ? undefined : codecs.encode[contentType];
  return encode ? encode(value as never, validate === undefined ? undefined : { validate }) : value;
}

/** The parameters of a call by location, as the serializers read them. */
interface RequestParameters {
  readonly path?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly header?: Readonly<Record<string, unknown>>;
  readonly cookie?: Readonly<Record<string, unknown>>;
  readonly querystring?: unknown;
}

/** The input with each request parameter that holds a Date or Temporal value in its wire form, each checked at the level of its side; the rest of the input is the same. */
export function convertRequestParameters<Input extends object>(codecs: OperationCodecs, input: Input, levels?: Pick<CallLevels, 'request' | 'requestHeaders'>): Input & RequestParameters {
  const converted: Record<string, unknown> = Object.fromEntries(Object.entries(input));
  for (const [key, encode] of Object.entries(codecs.parameters ?? {})) {
    const separator = key.indexOf(':');
    const location = key.slice(0, separator);
    const level = location === 'header' ? levels?.requestHeaders : levels?.request;
    const options = level === undefined ? undefined : { validate: level };
    if (location === 'querystring') {
      if (converted.querystring !== undefined) converted.querystring = encode(converted.querystring as never, options);
      continue;
    }
    const group = converted[location];
    if (typeof group !== 'object' || group === null) continue;
    const name = key.slice(separator + 1);
    const plain = (group as Record<string, unknown>)[name];
    if (plain !== undefined) converted[location] = { ...group, [name]: encode(plain as never, options) };
  }
  return converted as Input & RequestParameters;
}

/** Decodes a body or stream item the client has already checked at the response level: the codec converts only. */
const CHECKED: { readonly validate: false } = { validate: false };

/**
 * The conversion of a checked response body, stream item or response header to its plain form; none when no response of the operation converts.
 * The client check of a body or stream item ran before the decoder, so its codec converts only (a date that cannot convert still fails).
 * No other check sees a response header, so its codec checks at `headerLevel`.
 */
export function responseDecoder(codecs: OperationCodecs, headerLevel?: ValidationLevel): ResponseDecode | undefined {
  const { decode, headers } = codecs;
  if (!decode && !headers) return undefined;
  const headerOptions = headerLevel === undefined ? undefined : { validate: headerLevel };
  return (response, value, header) => {
    const table = header === undefined ? decode : headers;
    const key = `${response.status}:${header ?? response.contentType}`;
    return table && Object.hasOwn(table, key) ? table[key]!(value as never, header === undefined ? CHECKED : headerOptions) : value;
  };
}

/**
 * The raw wire request of an inbound operation, as the application's web framework holds it: the path, query, header and cookie values, and the body.
 * The body is the bare value when the operation has one request media type, and `{ contentType, value }` when it has several.
 */
export interface InboundRequest {
  readonly path?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly header?: Readonly<Record<string, unknown>>;
  readonly cookie?: Readonly<Record<string, unknown>>;
  readonly querystring?: unknown;
  readonly body?: unknown;
}

/** The wire response of an inbound operation: what the application's web framework writes. */
export interface InboundResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly body: unknown;
}

/** The checks of one inbound call. Only an SDK generated with validation has them (`inboundChecks` of the validation entry), so this module imports no validation code. */
export interface InboundChecks {
  /** Checks the wire request at the request levels; rejects with `LibErrorKind.Validation`. */
  readonly request: (request: InboundRequest) => Promise<void>;
  /** Checks the wire body of the response; none when the response level is off. */
  readonly response?: ResponseCheck;
  /** The level at which the converted response headers are checked. */
  readonly responseHeaders?: ValidationLevel;
}

/** What the SDK knows about an inbound operation besides its codecs. */
export interface InboundShape {
  /** The request media types: none for an operation with no body, one for a bare body, several for `{ contentType, value }`. */
  readonly media: readonly string[];
  /** The response keys the operation declares: a status, a range such as `2XX`, or `default`. */
  readonly statuses: readonly string[];
}

/** The declared key that answers `status`: the status itself, then its range, then `default`. */
function declaredStatus(statuses: readonly string[], status: number): string | undefined {
  const range = `${Math.floor(status / 100)}XX`;
  return statuses.find((item) => item === String(status)) ?? statuses.find((item) => item.toUpperCase() === range) ?? statuses.find((item) => item === 'default');
}

/** A failure in the response of the application is the application's fault, not the caller's input. */
function applicationFault(error: unknown): unknown {
  return error instanceof LibError
    ? new LibError(error.kind, `The response of the application breaks the operation's schema: ${error.message}`, error.issues, { cause: error, causedByInput: false })
    : error;
}

/** The request in its plain form: the parameters and the body convert once the checks have run, so no conversion checks again. */
function convertInboundRequest(codecs: OperationCodecs, media: readonly string[], request: InboundRequest): object {
  const parameters = convertRequestParameters(codecs, request, { request: false, requestHeaders: false });
  if (media.length === 0) return parameters;
  if (media.length === 1) return { ...parameters, body: convertRequestBody(codecs, media[0], parameters.body, false) };
  const body = parameters.body as { readonly contentType: string; readonly value: unknown } | undefined;
  return body === undefined ? parameters : { ...parameters, body: { ...body, value: convertRequestBody(codecs, body.contentType, body.value, false) } };
}

/**
 * The handler of one inbound operation: it checks the wire request and converts it to its plain form (a `Date` where the schema holds a date), calls the application,
 * then converts the application's response to its wire form and checks it. The codecs of an inbound operation hold the conversions the other way round
 * than the client's: `encode` and `parameters` turn a wire request into its plain form, `decode` and `headers` turn a plain response into its wire form.
 * A request that breaks the schema rejects with `LibErrorKind.Validation` and `causedByInput`, before the application is called;
 * a response that breaks it rejects with `causedByInput` false. The caller maps either to its protocol; golem chooses no status code.
 */
export function inboundHandler<Input, Output extends InboundResponse>(
  codecs: OperationCodecs,
  shape: InboundShape,
  call: (input: Input) => Promise<Output>,
  checks?: InboundChecks,
): (request: InboundRequest) => Promise<InboundResponse> {
  const convert = responseDecoder(codecs, checks?.responseHeaders);
  return async (request) => {
    await checks?.request(request);
    const plain = convertInboundRequest(codecs, shape.media, request);
    const response = await call(plain as Input);
    try {
      const key = declaredStatus(shape.statuses, response.status);
      const declared = { status: key ?? String(response.status), contentType: response.contentType };
      const wireBody = convert && response.contentType !== null ? convert(declared, response.body) : response.body;
      if (checks?.response) await checks.response(declared, wireBody);
      const headers = convert ? Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, value === undefined ? value : convert(declared, value, name)])) : response.headers;
      return { status: response.status, contentType: response.contentType, headers, body: wireBody };
    } catch (error) {
      throw applicationFault(error);
    }
  };
}
