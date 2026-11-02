import { isDate, isDateTime, isTime } from './rfc3339.js';
import type { SchemaIssue } from './issue-messages.js';
import { presentValue } from './presence.js';
export type { SchemaIssue, SchemaIssueDetail } from './issue-messages.js';

/**
 * A generated validator; with `all` false it returns at the first issue. With `sanity` true it checks the shape only: it
 * skips the value limits and the validation functions. A validator of a sanity-only module takes no flag.
 */
export type Validator = (value: unknown, all: boolean, sanity?: boolean) => readonly SchemaIssue[];

/** Length of `text` in Unicode code points; a lone surrogate counts as one. */
export function codePointLength(text: string): number {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index++) {
    const high = text.charCodeAt(index);
    if (high < 0xd800 || high > 0xdbff) continue;
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      count--;
      index++;
    }
  }
  return count;
}

/**
 * Whether `value` is a multiple of `divisor` (a finite number above 0). A number is judged by the decimal digits JSON writes for
 * it (its shortest text), so 0.3 is a multiple of 0.1 although 0.3 / 0.1 is off by rounding, and 3.000000000000001 is not a
 * multiple of 1. A whole divisor needs a whole value and an exact remainder. Any other divisor compares both numbers as integers
 * scaled by the smaller decimal exponent.
 */
export function isMultipleOf(value: number, divisor: number): boolean {
  if (Number.isInteger(divisor)) return Number.isInteger(value) && value % divisor === 0;
  if (!Number.isFinite(value)) return false;
  const split = (number: number): [digits: bigint, exponent: number] => {
    const match = /^-?([0-9]+)(?:[.]([0-9]+))?(?:e([+-][0-9]+))?$/.exec(String(number));
    if (match === null) throw new RangeError(`${number} has no decimal text`);
    const fraction = match[2] ?? '';
    return [BigInt(match[1]! + fraction), Number(match[3] ?? 0) - fraction.length];
  };
  const [valueDigits, valueExponent] = split(value);
  const [divisorDigits, divisorExponent] = split(divisor);
  const exponent = Math.min(valueExponent, divisorExponent);
  const scale = (shift: number): bigint => BigInt(10) ** BigInt(shift - exponent);
  return (valueDigits * scale(valueExponent)) % (divisorDigits * scale(divisorExponent)) === BigInt(0);
}

/**
 * JSON Schema equality over the JSON view, as `JSON.stringify` writes a value: numbers by value; arrays by position,
 * with an `undefined` item and a hole equal to `null`; objects by their own enumerable keys whose value is not
 * `undefined`, in any order.
 */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!jsonEqual(left[index] ?? null, right[index] ?? null)) return false;
    }
    return true;
  }
  // Counts the keys of each side inline, so a comparison allocates no key list.
  let count = 0;
  for (const key in left) {
    const value = presentValue(left, key);
    if (value === undefined) continue;
    const other = presentValue(right, key);
    if (other === undefined || !jsonEqual(value, other)) return false;
    count++;
  }
  for (const key in right) {
    if (presentValue(right, key) !== undefined) count--;
  }
  return count === 0;
}

/** Lists of at most this many items are compared pairwise: for a few items the double loop beats building a `Map`. */
const PAIRWISE_ITEMS = 6;

/**
 * The pair `[first, second]` that a double loop over `jsonEqual` finds in `list`: the lowest index that has a later equal
 * item, and the lowest later index equal to it; `undefined` when all items differ. A short list is that double loop. A longer
 * list takes one pass, linear in the size of the items. A primitive is its own key in a `Map`, so `0` and `-0` meet and `1`
 * and `'1'` do not; `NaN` equals nothing. An object, array or date is keyed by `structuralKey`, a text that two items share
 * exactly when `jsonEqual` says they are equal. No hash is used: a hash lets a crafted list collide and fall back to the
 * quadratic search.
 */
export function duplicateItems(list: readonly unknown[]): readonly [first: number, second: number] | undefined {
  if (list.length <= PAIRWISE_ITEMS) {
    for (let first = 0; first < list.length - 1; first++) {
      for (let second = first + 1; second < list.length; second++) {
        if (jsonEqual(list[first] ?? null, list[second] ?? null)) return [first, second];
      }
    }
    return undefined;
  }
  // Primitives, and objects that equal only themselves, by identity.
  const firstOf = new Map<unknown, number>();
  let structured: Map<string, number> | undefined;
  let identities: Map<unknown, number> | undefined;
  let first = -1;
  let second = -1;
  for (let index = 0; index < list.length; index++) {
    // The JSON view of an `undefined` item is `null`.
    const item = list[index] ?? null;
    let earlier: number | undefined;
    const key = typeof item === 'object' && item !== null ? structuralKey(item, (identities ??= new Map())) : undefined;
    if (key === undefined) {
      if (item !== item) continue;
      earlier = firstOf.get(item);
      if (earlier === undefined) firstOf.set(item, index);
    } else {
      earlier = (structured ??= new Map()).get(key);
      if (earlier === undefined) structured.set(key, index);
    }
    // The pair of the lowest first index wins; for one first index the first later match comes first.
    if (earlier !== undefined && (first < 0 || earlier < first)) {
      first = earlier;
      second = index;
    }
  }
  return first < 0 ? undefined : [first, second];
}

/** An array or object being keyed: its members are read from `index`, and `text` holds the keys of the members read so far. */
class KeyFrame {
  index = 0;
  failed = false;
  text: string;
  readonly size: number;

  /** `list` is set for an array; `names` are the sorted own enumerable names of any other object. `prefix` is the name part of this frame in its parent. */
  constructor(readonly value: object, readonly prefix: string, readonly list: readonly unknown[] | undefined, readonly names: readonly string[]) {
    this.text = list === undefined ? '{' : '[';
    this.size = list === undefined ? names.length : list.length;
  }
}

function openFrame(value: object, prefix: string): KeyFrame {
  return Array.isArray(value) ? new KeyFrame(value, prefix, value, []) : new KeyFrame(value, prefix, undefined, Object.keys(value).sort());
}

/**
 * The text of `value` that equals the text of another value exactly when `jsonEqual` says the two are equal, or `undefined`
 * when `value` equals only itself (it holds a `NaN` or an invalid date, which `jsonEqual` accepts only as the same object).
 * A member that equals only itself, such as a function, a symbol or such an inner object, is written as the number of its
 * identity. Strings and key names carry their length, so no text can forge the structure around it. The walk keeps its own
 * stack of frames, so an item nested to any depth builds its text without a deep call stack.
 */
function structuralKey(value: object, identities: Map<unknown, number>): string | undefined {
  if (value instanceof Date) return dateKey(value);
  const stack = [openFrame(value, '')];
  for (;;) {
    const frame = stack[stack.length - 1]!;
    let inner: object | undefined;
    while (inner === undefined && !frame.failed && frame.index < frame.size) {
      const position = frame.index++;
      let prefix = '';
      let member: unknown;
      if (frame.list !== undefined) {
        member = frame.list[position] ?? null;
      } else {
        const name = frame.names[position]!;
        member = presentValue(frame.value, name);
        if (member === undefined) continue;
        prefix = `${name.length}:${name}=`;
      }
      if (typeof member !== 'object' || member === null) {
        const text = scalarKey(member, identities);
        if (text === undefined) frame.failed = true;
        else frame.text += `${prefix}${text},`;
      } else if (member instanceof Date) {
        frame.text += `${prefix}${dateKey(member) ?? identityKey(member, identities)},`;
      } else {
        inner = member;
        stack.push(openFrame(member, prefix));
      }
    }
    if (inner !== undefined) continue;
    stack.pop();
    const text = frame.failed ? undefined : `${frame.text}${frame.list === undefined ? '}' : ']'}`;
    const parent = stack[stack.length - 1];
    if (parent === undefined) return text;
    parent.text += `${frame.prefix}${text ?? identityKey(frame.value, identities)},`;
  }
}

function dateKey(date: Date): string | undefined {
  const time = date.getTime();
  return time === time ? `d${time}` : undefined;
}

/** The text of a member that is not an object; `undefined` for `NaN`, which equals nothing. */
function scalarKey(member: unknown, identities: Map<unknown, number>): string | undefined {
  switch (typeof member) {
    case 'string': return `s${member.length}:${member}`;
    case 'number': return member === member ? `n${member}` : undefined;
    case 'boolean': return member ? 't' : 'f';
    case 'bigint': return `b${member}`;
    case 'object': return 'z';
    default: return identityKey(member, identities);
  }
}

/** A function, a symbol or an object that equals only itself, as the number of its identity. */
function identityKey(member: unknown, identities: Map<unknown, number>): string {
  let id = identities.get(member);
  if (id === undefined) {
    id = identities.size;
    identities.set(member, id);
  }
  return `@${id}`;
}

const DIGIT = '[0-9]';
const DURATION_TIME = `T(?:${DIGIT}+H(?:${DIGIT}+M(?:${DIGIT}+S)?)?|${DIGIT}+M(?:${DIGIT}+S)?|${DIGIT}+S)`;
const DURATION_DATE = `(?:${DIGIT}+Y(?:${DIGIT}+M(?:${DIGIT}+D)?)?|${DIGIT}+M(?:${DIGIT}+D)?|${DIGIT}+D)(?:${DURATION_TIME})?`;
const DURATION = new RegExp(`^P(?:${DURATION_DATE}|${DURATION_TIME}|${DIGIT}+W)$`);
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const EMAIL_LOCAL = new RegExp(`^(?:${ATOM}(?:\\.${ATOM})*|"(?:[ !#-\\[\\]-~]|\\\\[ -~])*")$`);

const PCT = '%[0-9A-Fa-f]{2}';
const URI_CHARS = "A-Za-z0-9\\-._~!$&'()*+,;=";
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const URI_USERINFO = new RegExp(`^(?:[${URI_CHARS}:]|${PCT})*$`);
const URI_REG_NAME = new RegExp(`^(?:[${URI_CHARS}]|${PCT})*$`);
const URI_PATH = new RegExp(`^(?:[${URI_CHARS}:@/]|${PCT})*$`);
const URI_QUERY = new RegExp(`^(?:[${URI_CHARS}:@/?]|${PCT})*$`);
const URI_FUTURE_HOST = new RegExp(`^v[0-9A-Fa-f]+\\.[A-Za-z0-9\\-._~!$&'()*+,;=:]+$`);
const URI_PARTS = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;
const URI_PORT = /^[0-9]*$/;

const INT32_LIMIT = 2 ** 31;
const FLOAT_MAX = 3.4028234663852886e38;

/** RFC 1123 hostname: dot-separated labels of letters, digits and inner hyphens. */
function isHostname(text: string): boolean {
  if (text.length > 253) return false;
  return text.split('.').every(label => HOST_LABEL.test(label));
}

function isIpv4(text: string): boolean {
  return IPV4.test(text);
}

function isIpv6(text: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return false;
  const compression = text.indexOf('::');
  if (compression !== text.lastIndexOf('::')) return false;
  const sides = compression < 0 ? [text] : [text.slice(0, compression), text.slice(compression + 2)];
  let groups = 0;
  for (const [sideIndex, side] of sides.entries()) {
    if (side === '') continue;
    const parts = side.split(':');
    for (const [partIndex, part] of parts.entries()) {
      if (part.includes('.')) {
        if (sideIndex !== sides.length - 1 || partIndex !== parts.length - 1 || !isIpv4(part)) return false;
        groups += 2;
      } else if (HEX_GROUP.test(part)) {
        groups += 1;
      } else {
        return false;
      }
    }
  }
  return compression < 0 ? groups === 8 : groups <= 7;
}

/** RFC 5321 mailbox: a dot-atom or quoted local part, then a hostname or an address literal. */
function isEmail(text: string): boolean {
  const at = text.lastIndexOf('@');
  if (at < 1 || at > 64) return false;
  if (!EMAIL_LOCAL.test(text.slice(0, at))) return false;
  const domain = text.slice(at + 1);
  if (domain.startsWith('[') && domain.endsWith(']')) {
    const literal = domain.slice(1, -1);
    // RFC 5321 writes the tag as `IPv6:`, and ABNF literals match any letter case.
    return literal.slice(0, 5).toLowerCase() === 'ipv6:' ? isIpv6(literal.slice(5)) : isIpv4(literal);
  }
  return isHostname(domain);
}

function isUriHost(host: string): boolean {
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) return false;
    const literal = host.slice(1, -1);
    return isIpv6(literal) || URI_FUTURE_HOST.test(literal);
  }
  return URI_REG_NAME.test(host);
}

function isUriAuthority(authority: string): boolean {
  const at = authority.lastIndexOf('@');
  if (at >= 0 && !URI_USERINFO.test(authority.slice(0, at))) return false;
  const hostPort = authority.slice(at + 1);
  const portStart = hostPort.endsWith(']') ? -1 : hostPort.lastIndexOf(':');
  const host = portStart < 0 ? hostPort : hostPort.slice(0, portStart);
  const port = portStart < 0 ? '' : hostPort.slice(portStart + 1);
  return isUriHost(host) && URI_PORT.test(port);
}

/** RFC 3986 URI, or with `relative` a URI reference where the scheme is optional. */
function isUri(text: string, relative: boolean): boolean {
  const parts = URI_PARTS.exec(text);
  if (!parts) return false;
  const [, scheme, authority, path = '', query, fragment] = parts;
  if (scheme === undefined ? !relative : !URI_SCHEME.test(scheme)) return false;
  if (authority !== undefined && !isUriAuthority(authority)) return false;
  if (authority !== undefined && path !== '' && !path.startsWith('/')) return false;
  if (!URI_PATH.test(path)) return false;
  return (query === undefined || URI_QUERY.test(query)) && (fragment === undefined || URI_QUERY.test(fragment));
}

function isRegex(text: string): boolean {
  try {
    new RegExp(text, 'u');
    return true;
  } catch {
    return false;
  }
}

/** RFC 4648 base64 with padding. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** RFC 6901: a reference token escapes `~` as `~0` and `/` as `~1`. */
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;
/** Relative JSON Pointer: a count of parents without a leading zero, then `#` or a JSON Pointer. */
const RELATIVE_JSON_POINTER = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~[01])*)*)$/;

const stringFormats: Readonly<Record<string, (text: string) => boolean>> = {
  'date-time': isDateTime,
  date: isDate,
  time: isTime,
  duration: text => DURATION.test(text),
  email: isEmail,
  hostname: isHostname,
  ipv4: isIpv4,
  ipv6: isIpv6,
  uri: text => isUri(text, false),
  'uri-reference': text => isUri(text, true),
  uuid: text => UUID.test(text),
  regex: isRegex,
  byte: text => BASE64.test(text),
  'json-pointer': text => JSON_POINTER.test(text),
  'relative-json-pointer': text => RELATIVE_JSON_POINTER.test(text),
  // These OpenAPI formats name how a string is shown or carried and say nothing about its characters: any string passes.
  password: () => true,
  binary: () => true,
  'media-range': () => true,
};

const numberFormats: Readonly<Record<string, (value: number) => boolean>> = {
  int32: value => Number.isInteger(value) && value >= -INT32_LIMIT && value < INT32_LIMIT,
  // A JSON number is a double, so an integer beyond Number.MAX_SAFE_INTEGER has already been rounded when it is read.
  int64: Number.isSafeInteger,
  float: value => Number.isFinite(value) && Math.abs(value) <= FLOAT_MAX,
  double: value => Number.isFinite(value),
};

/** True when `checkFormat` checks `format`; the validator compiler reports any other name. */
export function isKnownFormat(format: string): boolean {
  return Object.hasOwn(stringFormats, format) || Object.hasOwn(numberFormats, format);
}

/** True when `value` fits `format`, or when the format does not apply to its type or is not known. */
export function checkFormat(format: string, value: unknown): boolean {
  if (typeof value === 'string') return Object.hasOwn(stringFormats, format) ? stringFormats[format](value) : true;
  if (typeof value === 'number') return Object.hasOwn(numberFormats, format) ? numberFormats[format](value) : true;
  return true;
}

/** The validity of a `Date` binding: an instance can be a `Date` and hold no time (`new Date(NaN)`). */
export function hasFiniteTime(instance: unknown): boolean {
  return Number.isFinite((instance as Date).getTime());
}

/**
 * A test for the class at `path` below `globalThis` (`['Temporal', 'Instant']`), and for the function `valid`, which an instance must also
 * pass. The class is looked up on a call until it is found, because a polyfill may load after the validators: while it is missing, no value
 * is an instance of it. A found class is kept.
 */
export function globalInstanceTest(path: readonly string[], valid?: (instance: unknown) => boolean): (value: unknown) => boolean {
  let known: (new (...args: never[]) => unknown) | undefined;
  return (value) => {
    if (known === undefined) {
      let found: unknown = globalThis;
      for (const name of path) found = (found as Record<string, unknown> | undefined)?.[name];
      if (typeof found !== 'function') return false;
      known = found as new (...args: never[]) => unknown;
    }
    return value instanceof known && (valid === undefined || valid(value));
  };
}

/** `checkFormat` for one `format`, with the format looked up once: a generated fast check calls it per value. */
export function formatTest(format: string): (value: unknown) => boolean {
  const forString = Object.hasOwn(stringFormats, format) ? stringFormats[format] : undefined;
  const forNumber = Object.hasOwn(numberFormats, format) ? numberFormats[format] : undefined;
  return value => {
    if (typeof value === 'string') return forString === undefined || forString(value);
    if (typeof value === 'number') return forNumber === undefined || forNumber(value);
    return true;
  };
}
