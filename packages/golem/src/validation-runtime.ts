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
