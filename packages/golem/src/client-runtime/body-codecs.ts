import { IssueRepresentation, IssueSource, LibError, LibErrorKind, toIssue } from '../errors.js';
import type { QueryFieldTable, ValidationLevel } from '../object-codec.js';
import { decodeQueryField, gatherObjectField } from '../query-decode.js';
import { mediaRank, type BodyEncoder, type ClientRuntime, type EncodedBody, type EncodingMetadata, type OperationCodecs, type ResponseCheck, type ResponseDecode } from './core.js';
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

/**
 * The first line of a generated operation that reads its input: a value that is no object is rejected as a Validation error caused by input,
 * at any validation level, before a conversion or a check reads a part of it. An operation that reads no input does not call this.
 */
export function requireObjectInput(operation: string, input: unknown): void {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) return;
  throw new LibError(LibErrorKind.Validation, `The input of ${operation} must be an object.`, [toIssue({ code: 'type', expected: ['object'], path: [] }, IssueSource.OpenAPI, IssueRepresentation.Wire)], { causedByInput: true });
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

/** Decodes a value the response check has already seen: the codec converts only. */
const CHECKED: { readonly validate: false } = { validate: false };

/**
 * The conversion of a checked response body, stream item or response header to its plain form; none when no response of the operation converts.
 * The response check ran before the decoder, so its codec converts only (a date that cannot convert still fails).
 */
export function responseDecoder(codecs: OperationCodecs): ResponseDecode | undefined {
  const { decode, headers } = codecs;
  if (!decode && !headers) return undefined;
  return (response, value, header) => {
    const table = header === undefined ? decode : headers;
    const key = `${response.status}:${header ?? response.contentType}`;
    return table && Object.hasOwn(table, key) ? table[key]!(value as never, CHECKED) : value;
  };
}

/**
 * The raw wire request of an inbound operation, as the application's web framework holds it: the path, query, header and cookie values, and the body.
 * The body is the bare value when the operation has one request media type, and `{ contentType, value }` when it has several.
 */
export interface InboundRequest extends RequestParameters {
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
  /** The level of the response body check. A body that converts is checked by its conversion at this level, the plain value before it leaves, and the wire check skips it, unless the codecs list the body in `wireChecked`. */
  readonly responseLevel: ValidationLevel;
  /** Checks the wire body of the response, and each wire response header; none when the response and response header levels are off. */
  readonly response?: ResponseCheck;
}

/** The parameter locations whose text a framework gives as it came. */
type TextLocation = 'path' | 'query' | 'header' | 'cookie';
const TEXT_LOCATIONS: readonly TextLocation[] = ['path', 'query', 'header', 'cookie'];

/** What the SDK knows about an inbound operation besides its codecs. */
interface InboundShape {
  /** The request media types: none for an operation with no body, one for a bare body, several for `{ contentType, value }`. */
  readonly media: readonly string[];
  /** The declared names of the header parameters: a framework gives them in any letter case. */
  readonly requestHeaders: readonly string[];
  /** The text parameters that decode to a number or boolean, or to an array, by location and name. */
  readonly text?: Readonly<Partial<Record<TextLocation, QueryFieldTable>>>;
  /** The responses the operation declares: a status, a range such as `2XX`, or `default`, with its media types and headers. */
  readonly responses: readonly {
    readonly status: string;
    readonly content: readonly string[];
    readonly headers: readonly { readonly name: string; readonly required: boolean }[];
  }[];
}

type ShapedResponse = InboundShape['responses'][number];

/** The declared response that answers `status`: the status itself, then its range, then `default`. */
function declaredResponse(responses: readonly ShapedResponse[], status: number): ShapedResponse | undefined {
  const range = `${Math.floor(status / 100)}XX`;
  return responses.find((item) => item.status === String(status)) ?? responses.find((item) => item.status.toUpperCase() === range) ?? responses.find((item) => item.status === 'default');
}

/** The declared media type that answers `contentType`, as the client picks it (parameters ignored, the closest range first); null for a response without content. */
function declaredMedia(content: readonly string[], contentType: string | null): string | null | undefined {
  if (contentType === null) return content.length === 0 ? null : undefined;
  let best: string | undefined;
  let bestRank = Infinity;
  for (const item of content) {
    const rank = mediaRank(contentType, item);
    if (rank !== null && rank < bestRank) [best, bestRank] = [item, rank];
  }
  return best;
}

/** A failure in the response of the application is the application's fault, not the caller's input. */
function applicationFault(error: unknown): unknown {
  return error instanceof LibError
    ? new LibError(error.kind, `The response of the application breaks the operation's schema: ${error.message}`, error.issues, { cause: error, causedByInput: false })
    : error;
}

/** `headers` with each key that matches a declared name in any letter case written under that name; other keys stay. */
function declaredNames(headers: Readonly<Record<string, unknown>>, names: readonly string[]): Record<string, unknown> {
  const declared = new Map(names.map((name) => [name.toLowerCase(), name]));
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) Object.defineProperty(renamed, declared.get(key.toLowerCase()) ?? key, { value, writable: true, enumerable: true, configurable: true });
  return renamed;
}

/** The request with its header names as declared and its text parameters decoded to the types they declare, ready for the wire check. */
function inboundRequestText(shape: InboundShape, request: InboundRequest): InboundRequest {
  const text: Record<string, unknown> = { ...request };
  for (const location of TEXT_LOCATIONS) {
    const group = request[location];
    if (typeof group !== 'object' || group === null) continue;
    const named = location === 'header' ? declaredNames(group, shape.requestHeaders) : { ...group };
    for (const [name, field] of Object.entries(shape.text?.[location] ?? {})) {
      // An object that its style spreads over the keys of the group is gathered under its name.
      const spread = gatherObjectField(named, name, field);
      for (const key of spread?.keys ?? []) delete named[key];
      if (spread || Object.hasOwn(named, name)) Object.defineProperty(named, name, { value: decodeQueryField(spread ? spread.value : named[name], field), writable: true, enumerable: true, configurable: true });
    }
    text[location] = named;
  }
  return text;
}

/** The request in its plain form: the parameters and the body convert once the checks have run, so no conversion checks again. */
function convertInboundRequest(codecs: OperationCodecs, media: readonly string[], request: InboundRequest): object {
  const parameters = convertRequestParameters(codecs, request, { request: false, requestHeaders: false });
  if (media.length === 0 || parameters.body === undefined) return parameters;
  if (media.length === 1) return { ...parameters, body: convertRequestBody(codecs, media[0], parameters.body, false) };
  const body = parameters.body as { readonly contentType: string; readonly value: unknown };
  return { ...parameters, body: { ...body, value: convertRequestBody(codecs, body.contentType, body.value, false) } };
}

/**
 * The handler of one inbound operation: it checks the wire request and converts it to its plain form (a `Date` where the schema holds a date), calls the application,
 * then converts the application's response to its wire form and checks it. The codecs of an inbound operation hold the conversions the other way round
 * than the client's: `encode` and `parameters` turn a wire request into its plain form, `decode` and `headers` turn a plain response into its wire form.
 * The request header names match the declared names in any letter case, and path, query, header and cookie text decodes to the number or boolean it declares (the rule of a Nest query).
 * A request that breaks the schema rejects with `LibErrorKind.Validation` and `causedByInput`, before the application is called;
 * a response that breaks it, or whose status or media type the operation does not declare, rejects with `causedByInput` false. The caller maps either to its protocol; golem chooses no status code.
 * A response body that converts is checked once, as a plain value by its conversion; any other body is checked in its wire form.
 */
export function inboundHandler<Input, Output extends InboundResponse>(
  codecs: OperationCodecs,
  shape: InboundShape,
  call: (input: Input) => Promise<Output>,
  checks?: InboundChecks,
): (request: InboundRequest) => Promise<InboundResponse> {
  const convert = responseDecoder(codecs);
  return async (request) => {
    const wire = inboundRequestText(shape, request);
    await checks?.request(wire);
    const plain = convertInboundRequest(codecs, shape.media, wire);
    const response = await call(plain as Input);
    try {
      const declaredAs = declaredResponse(shape.responses, response.status);
      const media = declaredAs === undefined ? undefined : declaredMedia(declaredAs.content, response.contentType);
      if (media === undefined && checks && checks.responseLevel !== false) {
        throw new LibError(LibErrorKind.Validation, `Undeclared response of the operation: HTTP ${response.status} ${response.contentType ?? '(no content type)'}`, [], { causedByInput: false });
      }
      const declared = { status: declaredAs?.status ?? String(response.status), contentType: media === undefined ? response.contentType : media };
      const bodyCodec = declared.contentType === null || !codecs.decode ? undefined : Object.hasOwn(codecs.decode, `${declared.status}:${declared.contentType}`) ? codecs.decode[`${declared.status}:${declared.contentType}`] : undefined;
      let body = response.body;
      if (bodyCodec) body = bodyCodec(body as never, checks === undefined ? undefined : { validate: checks.responseLevel });
      if (checks?.response && (!bodyCodec || codecs.wireChecked?.includes(`${declared.status}:${declared.contentType}`))) await checks.response(declared, body);
      const sent = declaredNames(response.headers, declaredAs?.headers.map((item) => item.name) ?? []);
      for (const [name, value] of Object.entries(sent)) {
        const wireValue = value === undefined || !convert ? value : convert(declared, value, name);
        if (checks?.response && wireValue !== undefined) await checks.response(declared, wireValue, name);
        sent[name] = wireValue;
      }
      for (const item of declaredAs?.headers ?? []) {
        if (item.required && sent[item.name] === undefined && checks?.response) await checks.response(declared, undefined, item.name);
      }
      return { status: response.status, contentType: response.contentType, headers: sent, body };
    } catch (error) {
      throw applicationFault(error);
    }
  };
}
