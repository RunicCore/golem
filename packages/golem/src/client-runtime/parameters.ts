import type { ClientRuntime, ParameterSerializerContext } from './core.js';

/** `value` when it is a primitive; an object has no wire text, and an array or object nested in an array or object has none either. `parameter` names the parameter in the error. */
function primitive(parameter: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    throw new TypeError(`Parameter "${parameter}" must be a primitive, or an array or object with primitive items and members`);
  }
  return value;
}

function formValue(form: URLSearchParams, parameter: string, name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) form.append(name, String(primitive(parameter, item)));
    return;
  }
  form.set(name, String(primitive(parameter, value)));
}

export function encode(value: unknown, allowReserved = false): string {
  const text = String(value);
  if (!allowReserved) return encodeURIComponent(text);
  // allowReserved: RFC 3986 reserved characters stay literal except those that
  // would change the query's structure (# [ ] & +); existing %XX triples pass through.
  return text.split(/(%[0-9A-Fa-f]{2})/).map((part, index) => index % 2 === 1
    ? part
    : encodeURIComponent(part).replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B|3D)/gi, (match) =>
      String.fromCharCode(Number.parseInt(match.slice(1), 16)))).join('');
}

function entries(value: unknown): Array<[string, unknown]> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

/** The text of a parameter that is not an array or an object with entries; any other object has no wire text. */
function scalarText(name: string, value: unknown): string {
  return encode(primitive(name, value));
}

function serializeSimple(name: string, value: unknown, explode: boolean): string {
  if (Array.isArray(value)) return value.map((item) => encode(primitive(name, item))).join(',');
  const pairs = entries(value);
  if (pairs.length) {
    return pairs.map(([key, item]) =>
      explode ? `${encode(key)}=${encode(primitive(name, item))}` : `${encode(key)},${encode(primitive(name, item))}`
    ).join(',');
  }
  return scalarText(name, value);
}

/** `name` is the header parameter, for the error of a value that has no wire text. */
export function serializeHeaderSimple(_runtime: ClientRuntime, value: unknown, explode: boolean, name = 'header'): string {
  if (Array.isArray(value)) return value.map((item) => String(primitive(name, item))).join(',');
  const pairs = entries(value);
  if (pairs.length) {
    return pairs.map(([key, item]) =>
      explode ? `${key}=${primitive(name, item)}` : `${key},${primitive(name, item)}`
    ).join(',');
  }
  return String(primitive(name, value));
}

export function serializeContentParameter(
  runtime: ClientRuntime,
  value: unknown,
  context: ParameterSerializerContext,
): string {
  const serializers = runtime.options.parameterSerializers ?? {};
  const normalized = context.contentType.toLowerCase();
  const serializer = serializers[normalized] ?? serializers['*/*'];
  if (serializer) return serializer(value, context);
  if (normalized.includes('json')) return JSON.stringify(value);
  if (normalized === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams();
    for (const [key, item] of entries(value)) formValue(form, context.name, key, item);
    return form.toString();
  }
  if (normalized.startsWith('text/')) return String(value);
  throw new Error(
    `No parameter serializer configured for media type: ${context.contentType}`,
  );
}

function pathText(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): string {
  if (style === 'simple') return serializeSimple(name, value, explode);
  if (style === 'label') {
    if (Array.isArray(value)) return `.${value.map((item) => encode(primitive(name, item))).join(explode ? '.' : ',')}`;
    const pairs = entries(value);
    if (pairs.length) {
      return `.${pairs.map(([key, item]) =>
        explode ? `${encode(key)}=${encode(primitive(name, item))}` : `${encode(key)},${encode(primitive(name, item))}`
      ).join(explode ? '.' : ',')}`;
    }
    return `.${scalarText(name, value)}`;
  }
  if (style === 'matrix') {
    if (Array.isArray(value)) {
      return explode
        ? value.map((item) => `;${encode(name)}=${encode(primitive(name, item))}`).join('')
        : `;${encode(name)}=${value.map((item) => encode(primitive(name, item))).join(',')}`;
    }
    const pairs = entries(value);
    if (pairs.length) {
      return explode
        ? pairs.map(([key, item]) => `;${encode(key)}=${encode(primitive(name, item))}`).join('')
        : `;${encode(name)}=${pairs.flatMap(([key, item]) => [encode(key), encode(primitive(name, item))]).join(',')}`;
    }
    return `;${encode(name)}=${scalarText(name, value)}`;
  }
  throw new Error(`Unsupported path parameter style: ${style}`);
}

export function serializePath(
  _runtime: ClientRuntime,
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
  /** The route writes the parameter as a whole path segment (`/{id}`); inside a longer segment (`/{id}.json`) no text is a dot-segment. */
  wholeSegment = true,
): string {
  const text = pathText(name, value, style, explode);
  // A client or server that resolves dot-segments (RFC 3986 section 5.2.4) turns ".." into the parent
  // and "." or an empty segment into the list route.
  if (wholeSegment && (text === '' || text === '.' || text === '..')) {
    throw new TypeError(`Parameter "${name}" is written as "${text}", which is a dot-segment or an empty path segment`);
  }
  return text;
}

export function appendQuery(
  _runtime: ClientRuntime,
  query: string[],
  name: unknown,
  value: unknown,
  allowReserved: boolean,
): void {
  query.push(`${encode(name)}=${encode(value, allowReserved)}`);
}

export function addQueryParameter(
  runtime: ClientRuntime,
  query: string[],
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
  allowReserved: boolean,
): void {
  if (value === undefined || value === null) return;
  if (style === 'deepObject') {
    const append = (prefix: string, item: unknown): void => {
      if (item === undefined || item === null) return;
      if (typeof item === 'object' && !Array.isArray(item)) {
        for (const [key, child] of entries(item)) append(`${prefix}[${encode(key)}]`, child);
        return;
      }
      query.push(`${prefix}=${encode(primitive(name, item), allowReserved)}`);
    };
    for (const [key, item] of entries(value)) append(`${encode(name)}[${encode(key)}]`, item);
    return;
  }
  const delimiter = style === 'spaceDelimited' ? '%20' : style === 'pipeDelimited' ? '|' : ',';
  if (Array.isArray(value)) {
    if (style === 'form' && explode) {
      for (const item of value) appendQuery(runtime, query, name, primitive(name, item), allowReserved);
    } else {
      query.push(`${encode(name)}=${value.map((item) => encode(primitive(name, item), allowReserved)).join(delimiter)}`);
    }
    return;
  }
  const pairs = entries(value);
  if (pairs.length) {
    if (style === 'form' && explode) {
      for (const [key, item] of pairs) appendQuery(runtime, query, key, primitive(name, item), allowReserved);
    } else {
      const flattened = pairs
        .flatMap(([key, item]) => [encode(key), encode(primitive(name, item), allowReserved)])
        .join(delimiter);
      query.push(`${encode(name)}=${flattened}`);
    }
    return;
  }
  // An empty object has no entries to send, as an undefined value has none (RFC 6570).
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && !Object.keys(value).length) return;
  scalarText(name, value);
  appendQuery(runtime, query, name, value, allowReserved);
}

export function setQueryString(
  runtime: ClientRuntime,
  query: string[],
  value: unknown,
  context: ParameterSerializerContext,
): void {
  if (value === undefined || value === null) return;
  if (context.contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams();
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) formValue(form, context.name, key, item);
    } else {
      form.set('', String(primitive(context.name, value)));
    }
    const serialized = form.toString();
    if (serialized) query.push(serialized.replace(/^=/, ''));
    return;
  }
  const serialized = serializeContentParameter(runtime, value, context);
  query.push(encode(serialized));
}

function pushCookie(
  cookies: string[],
  name: string,
  value: unknown,
  explode: boolean,
  write: (part: string) => string,
): void {
  if (value === undefined || value === null) return;
  const text = (part: unknown): string => write(String(primitive(name, part)));
  if (Array.isArray(value)) {
    if (explode) {
      for (const item of value) cookies.push(`${write(name)}=${text(item)}`);
    } else {
      cookies.push(`${write(name)}=${value.map((item) => text(item)).join(',')}`);
    }
    return;
  }
  const pairs = entries(value);
  if (pairs.length && explode) {
    for (const [key, item] of pairs) cookies.push(`${write(key)}=${text(item)}`);
    return;
  }
  const serialized = pairs.length
    ? pairs.flatMap(([key, item]) => [write(key), text(item)]).join(',')
    : write(String(primitive(name, value)));
  cookies.push(`${write(name)}=${serialized}`);
}

export function addCookieParameter(
  _runtime: ClientRuntime,
  cookies: string[],
  name: string,
  value: unknown,
  explode: boolean,
): void {
  pushCookie(cookies, name, value, explode, (part) => encode(part));
}

/**
 * A `style: cookie` parameter is written without percent-encoding (OpenAPI 3.2). A value that holds
 * `;` or a control character, which would end the cookie or the header line, is a TypeError.
 */
export function addCookieStyleParameter(
  _runtime: ClientRuntime,
  cookies: string[],
  name: string,
  value: unknown,
  explode: boolean,
): void {
  pushCookie(cookies, name, value, explode, (part) => {
    if (/[;\u0000-\u001f\u007f]/.test(part)) {
      throw new TypeError(`Parameter "${name}" holds a ";" or a control character, which a cookie cannot carry unencoded`);
    }
    return part;
  });
}
