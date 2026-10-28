import type { ClientRuntime, ParameterSerializerContext } from './core.js';

function formValue(form: URLSearchParams, name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) form.append(name, String(item));
    return;
  }
  form.set(name, String(value));
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

function serializeSimple(value: unknown, explode: boolean): string {
  if (Array.isArray(value)) return value.map((item) => encode(item)).join(',');
  const pairs = entries(value);
  if (pairs.length) {
    return pairs.map(([key, item]) =>
      explode ? `${encode(key)}=${encode(item)}` : `${encode(key)},${encode(item)}`
    ).join(',');
  }
  return encode(value);
}

export function serializeHeaderSimple(_runtime: ClientRuntime, value: unknown, explode: boolean): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(',');
  const pairs = entries(value);
  if (pairs.length) {
    return pairs.map(([key, item]) =>
      explode ? `${key}=${item}` : `${key},${item}`
    ).join(',');
  }
  return String(value);
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
    for (const [key, item] of entries(value)) formValue(form, key, item);
    return form.toString();
  }
  if (normalized.startsWith('text/')) return String(value);
  throw new Error(
    `No parameter serializer configured for media type: ${context.contentType}`,
  );
}

export function serializePath(
  _runtime: ClientRuntime,
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): string {
  if (style === 'simple') return serializeSimple(value, explode);
  if (style === 'label') {
    if (Array.isArray(value)) return `.${value.map((item) => encode(item)).join(explode ? '.' : ',')}`;
    const pairs = entries(value);
    if (pairs.length) {
      return `.${pairs.map(([key, item]) =>
        explode ? `${encode(key)}=${encode(item)}` : `${encode(key)},${encode(item)}`
      ).join(explode ? '.' : ',')}`;
    }
    return `.${encode(value)}`;
  }
  if (style === 'matrix') {
    if (Array.isArray(value)) {
      return explode
        ? value.map((item) => `;${encode(name)}=${encode(item)}`).join('')
        : `;${encode(name)}=${value.map((item) => encode(item)).join(',')}`;
    }
    const pairs = entries(value);
    if (pairs.length) {
      return explode
        ? pairs.map(([key, item]) => `;${encode(key)}=${encode(item)}`).join('')
        : `;${encode(name)}=${pairs.flatMap(([key, item]) => [encode(key), encode(item)]).join(',')}`;
    }
    return `;${encode(name)}=${encode(value)}`;
  }
  throw new Error(`Unsupported path parameter style: ${style}`);
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
      query.push(`${prefix}=${encode(item, allowReserved)}`);
    };
    for (const [key, item] of entries(value)) append(`${encode(name)}[${encode(key)}]`, item);
    return;
  }
  const delimiter = style === 'spaceDelimited' ? '%20' : style === 'pipeDelimited' ? '|' : ',';
  if (Array.isArray(value)) {
    if (style === 'form' && explode) {
      for (const item of value) appendQuery(runtime, query, name, item, allowReserved);
    } else {
      query.push(`${encode(name)}=${value.map((item) => encode(item, allowReserved)).join(delimiter)}`);
    }
    return;
  }
  const pairs = entries(value);
  if (pairs.length) {
    if (style === 'form' && explode) {
      for (const [key, item] of pairs) appendQuery(runtime, query, key, item, allowReserved);
    } else {
      const flattened = pairs
        .flatMap(([key, item]) => [encode(key), encode(item, allowReserved)])
        .join(delimiter);
      query.push(`${encode(name)}=${flattened}`);
    }
    return;
  }
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
      for (const [name, item] of Object.entries(value)) formValue(form, name, item);
    } else {
      form.set('', String(value));
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
  text: (part: unknown) => string,
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (explode) {
      for (const item of value) cookies.push(`${text(name)}=${text(item)}`);
    } else {
      cookies.push(`${text(name)}=${value.map((item) => text(item)).join(',')}`);
    }
    return;
  }
  const pairs = entries(value);
  if (pairs.length && explode) {
    for (const [key, item] of pairs) cookies.push(`${text(key)}=${text(item)}`);
    return;
  }
  const serialized = pairs.length
    ? pairs.flatMap(([key, item]) => [text(key), text(item)]).join(',')
    : text(value);
  cookies.push(`${text(name)}=${serialized}`);
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

export function addCookieStyleParameter(
  _runtime: ClientRuntime,
  cookies: string[],
  name: string,
  value: unknown,
  explode: boolean,
): void {
  pushCookie(cookies, name, value, explode, String);
}
