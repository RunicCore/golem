import { IssueRepresentation, IssueSource, LibError, LibErrorKind, toIssue } from '../errors.js';
import type { ValidationLevel } from '../object-codec.js';
import type { BodyEncoder, ClientRuntime, EncodedBody, EncodingMetadata, OperationCodecs, ResponseDecode } from './core.js';
import { mediaEssence } from './media-type.js';
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
  const essence = mediaEssence(contentType);
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
  const essence = mediaEssence(contentType);
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
          const jsonPart = partType?.toLowerCase().includes('json') === true;
          // A null is written only in a JSON part, as `null`; a text part has no form for it, as a form-urlencoded body has none.
          if (entry === null && !jsonPart) continue;
          if (entry instanceof Blob) form.append(name, entry);
          else if (partType) {
            // A JSON part holds JSON text for every value, so the string `abc` is sent as `"abc"`.
            const serialized = jsonPart || (typeof entry === 'object' && entry !== null) ? JSON.stringify(entry) : String(entry);
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
