import type { IssuePath, JsonValue } from './errors.js';

/** Type names a schema issue reports; `Date` is golem's own check for date fields. */
export type JsonTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array' | 'Date';

export type SchemaIssueDetail =
  | { readonly code: 'type'; readonly expected: readonly JsonTypeName[] }
  | { readonly code: 'instance'; readonly model: string }
  | { readonly code: 'required' | 'unknownKey' | 'invalidKey'; readonly key: string }
  | { readonly code: 'literal'; readonly expected: readonly JsonValue[] }
  | { readonly code: 'union'; readonly matched: number }
  | {
    readonly code: 'tooSmall' | 'tooBig';
    readonly measure: 'length' | 'items' | 'properties' | 'value' | 'matches';
    readonly limit: number;
    readonly inclusive: boolean;
  }
  | { readonly code: 'pattern'; readonly pattern: string }
  | { readonly code: 'format'; readonly format: string }
  | { readonly code: 'multipleOf'; readonly divisor: number }
  | { readonly code: 'unique'; readonly indexes: readonly [number, number] }
  | { readonly code: 'not' }
  | { readonly code: 'never' }
  | { readonly code: 'custom'; readonly reason?: string };

export type SchemaIssue = { readonly path: IssuePath } & SchemaIssueDetail;

/** A generated validator; with `all` false it returns at the first issue. */
export type Validator = (value: unknown, all: boolean) => readonly SchemaIssue[];

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

/** JSON Schema equality: numbers by value, arrays by position, objects by own keys in any order. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => jsonEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key)
    && jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

const DIGIT = '[0-9]';
const DURATION_TIME = `T(?:${DIGIT}+H(?:${DIGIT}+M(?:${DIGIT}+S)?)?|${DIGIT}+M(?:${DIGIT}+S)?|${DIGIT}+S)`;
const DURATION_DATE = `(?:${DIGIT}+Y(?:${DIGIT}+M(?:${DIGIT}+D)?)?|${DIGIT}+M(?:${DIGIT}+D)?|${DIGIT}+D)(?:${DURATION_TIME})?`;
const DURATION = new RegExp(`^P(?:${DURATION_DATE}|${DURATION_TIME}|${DIGIT}+W)$`);
const TIME = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
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
const INT64_LIMIT = 2 ** 63;
const FLOAT_MAX = 3.4028234663852886e38;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const days = month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

/** RFC 3339 full-time. Second 60 is a leap second and is accepted only at 23:59:60 UTC. */
function isTime(text: string): boolean {
  const match = TIME.exec(text);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 60) return false;
  let offset = 0;
  if (match[4] !== undefined) {
    const offsetHour = Number(match[5]);
    const offsetMinute = Number(match[6]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
    offset = (match[4] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  if (second < 60) return true;
  return (((hour * 60 + minute - offset) % 1440) + 1440) % 1440 === 23 * 60 + 59;
}

function isDateTime(text: string): boolean {
  const split = text.search(/[Tt]/);
  return split > 0 && isDate(text.slice(0, split)) && isTime(text.slice(split + 1));
}

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
    return literal.startsWith('IPv6:') ? isIpv6(literal.slice(5)) : isIpv4(literal);
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
};

const numberFormats: Readonly<Record<string, (value: number) => boolean>> = {
  int32: value => Number.isInteger(value) && value >= -INT32_LIMIT && value < INT32_LIMIT,
  // JSON numbers are doubles, so 9223372036854775807 reads as 2 ** 63; that value is accepted.
  int64: value => Number.isInteger(value) && value >= -INT64_LIMIT && value <= INT64_LIMIT,
  float: value => Number.isFinite(value) && Math.abs(value) <= FLOAT_MAX,
  double: value => Number.isFinite(value),
};

/** True when `value` fits `format`, or when the format does not apply to its type or is not known. */
export function checkFormat(format: string, value: unknown): boolean {
  if (typeof value === 'string') return Object.hasOwn(stringFormats, format) ? stringFormats[format](value) : true;
  if (typeof value === 'number') return Object.hasOwn(numberFormats, format) ? numberFormats[format](value) : true;
  return true;
}

function counted(count: number, [one, many]: readonly [string, string]): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeList(items: readonly string[], conjunction: string): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}

const sizeNouns = {
  length: ['character', 'characters'],
  items: ['item', 'items'],
  properties: ['property', 'properties'],
  matches: ['matching item', 'matching items'],
} as const;

function limitMessage(detail: Extract<SchemaIssueDetail, { code: 'tooSmall' | 'tooBig' }>): string {
  const small = detail.code === 'tooSmall';
  if (detail.measure === 'value') {
    return `Must be ${small ? (detail.inclusive ? 'at least' : 'greater than') : (detail.inclusive ? 'at most' : 'less than')} ${detail.limit}`;
  }
  const bound = small ? (detail.inclusive ? 'at least' : 'more than') : (detail.inclusive ? 'at most' : 'fewer than');
  const size = counted(detail.limit, sizeNouns[detail.measure]);
  return detail.measure === 'length' ? `Must be ${bound} ${size}` : `Must have ${bound} ${size}`;
}

/** golem's default English text for an issue; `messages()` overrides replace it. */
export function schemaIssueMessage(detail: SchemaIssueDetail): string {
  switch (detail.code) {
    case 'type': return `Expected ${describeList(detail.expected, 'or')}`;
    case 'instance': return `Expected an instance of ${detail.model}`;
    case 'required': return `Missing required property "${detail.key}"`;
    case 'unknownKey': return `Unknown property "${detail.key}"`;
    case 'invalidKey': return `Invalid property name "${detail.key}"`;
    case 'literal': return `Must be ${describeList(detail.expected.map(value => JSON.stringify(value)), 'or')}`;
    case 'union': return detail.matched === 0
      ? 'Does not match any of the allowed alternatives'
      : 'Matches more than one alternative; it must match exactly one';
    case 'tooSmall':
    case 'tooBig': return limitMessage(detail);
    case 'pattern': return `Must match the pattern ${detail.pattern}`;
    case 'format': return `Must be a valid ${detail.format}`;
    case 'multipleOf': return `Must be a multiple of ${detail.divisor}`;
    case 'unique': return `Items at index ${detail.indexes[0]} and ${detail.indexes[1]} are equal; items must be unique`;
    case 'not': return 'Must not match the excluded shape';
    case 'never': return 'No value is allowed here';
    case 'custom': return detail.reason ?? 'Invalid value';
  }
}
