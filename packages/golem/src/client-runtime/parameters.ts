import type { ClientRuntime, ParameterSerializerContext } from './core.js';
import { parameterStyleRule, type ParameterLocation, type ParameterStyleRule } from './parameter-styles.js';

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

/** The rule of `style` for `location`; a style the location does not have is an error of the document. */
function styleRule(location: ParameterLocation, style: string | undefined, explode: boolean): ParameterStyleRule {
  const rule = parameterStyleRule(location, style, explode);
  if (rule === undefined) throw new Error(`Unsupported ${location} parameter style: ${style}`);
  return rule;
}

/** The text of an array or an object in one piece, as the rule writes it: the items or members joined, each by `write`. Undefined for a value that is neither. */
function joinedText(name: string, value: unknown, rule: ParameterStyleRule, write: (text: string) => string): string | undefined {
  if (Array.isArray(value) && rule.array.layout === 'joined') return value.map((item) => write(String(primitive(name, item)))).join(rule.array.separator);
  const pairs = entries(value);
  if (!pairs.length || (rule.object.layout !== 'flat' && rule.object.layout !== 'keyed')) return undefined;
  const { layout, separator } = rule.object;
  return (layout === 'keyed'
    ? pairs.map(([key, item]) => `${write(key)}=${write(String(primitive(name, item)))}`)
    : pairs.flatMap(([key, item]) => [write(key), write(String(primitive(name, item)))])).join(separator);
}

/** `name` is the header parameter, for the error of a value that has no wire text. */
export function serializeHeaderSimple(_runtime: ClientRuntime, value: unknown, explode: boolean, name = 'header'): string {
  return joinedText(name, value, styleRule('header', 'simple', explode), (text) => text) ?? String(primitive(name, value));
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
  if (normalized.startsWith('text/')) return String(primitive(context.name, value));
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
  const rule = styleRule('path', style, explode);
  const joined = joinedText(name, value, rule, encode);
  if (rule.prefix === undefined) return joined ?? scalarText(name, value);
  if (rule.prefix === 'label') return `.${joined ?? scalarText(name, value)}`;
  // Matrix: an exploded array repeats `;name=`, an exploded object writes `;key=value` for each member, and any other value has one `;name=` before its text.
  if (Array.isArray(value) && rule.array.layout === 'repeated') return value.map((item) => `;${encode(name)}=${encode(primitive(name, item))}`).join('');
  if (joined !== undefined && rule.object.layout === 'keyed' && !Array.isArray(value)) return `;${joined}`;
  return `;${encode(name)}=${joined ?? scalarText(name, value)}`;
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
  const rule = parameterStyleRule('query', style, explode) ?? styleRule('query', 'form', explode);
  const encoded = (text: string): string => encode(text, allowReserved);
  const joined = joinedText(name, value, rule, encoded);
  if (Array.isArray(value)) {
    if (rule.array.layout === 'repeated') {
      for (const item of value) appendQuery(runtime, query, name, primitive(name, item), allowReserved);
    } else {
      // A space is written as %20 in the query string.
      query.push(`${encode(name)}=${(joined ?? '').replaceAll(' ', '%20')}`);
    }
    return;
  }
  const pairs = entries(value);
  if (pairs.length) {
    if (rule.object.layout === 'keys') {
      for (const [key, item] of pairs) appendQuery(runtime, query, key, primitive(name, item), allowReserved);
    } else {
      query.push(`${encode(name)}=${(joined ?? '').replaceAll(' ', '%20')}`);
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
  const rule = styleRule('cookie', 'form', explode);
  const text = (part: unknown): string => write(String(primitive(name, part)));
  if (Array.isArray(value) && rule.array.layout === 'repeated') {
    for (const item of value) cookies.push(`${write(name)}=${text(item)}`);
    return;
  }
  const pairs = entries(value);
  if (pairs.length && rule.object.layout === 'keys') {
    for (const [key, item] of pairs) cookies.push(`${write(key)}=${text(item)}`);
    return;
  }
  cookies.push(`${write(name)}=${joinedText(name, value, rule, write) ?? write(String(primitive(name, value)))}`);
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
