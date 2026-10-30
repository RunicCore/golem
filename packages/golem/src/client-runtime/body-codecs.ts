import type { BodyEncoder, ClientRuntime, EncodedBody, EncodingMetadata, OperationCodecs, ResponseDecode } from './core.js';
import { addQueryParameter } from './parameters.js';

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

/** The request body in its wire form: the generated encoder of its media type converts it, and a body that converts nothing has none. */
export function convertRequestBody(codecs: OperationCodecs, contentType: string | undefined, value: unknown): unknown {
  const encode = value === undefined || contentType === undefined || !codecs.encode || !Object.hasOwn(codecs.encode, contentType) ? undefined : codecs.encode[contentType];
  return encode ? encode(value as never) : value;
}

/** The conversion of a checked response body or stream item to its plain form; none when no response of the operation converts. */
export function responseDecoder(codecs: OperationCodecs): ResponseDecode | undefined {
  const decode = codecs.decode;
  if (!decode) return undefined;
  return (response, value) => {
    const key = `${response.status}:${response.contentType}`;
    return Object.hasOwn(decode, key) ? decode[key]!(value as never) : value;
  };
}
