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

/** A list of at most this many primitives is compared pairwise: for a few items the double loop beats building a `Map`. */
const PAIRWISE_ITEMS = 6;

/**
 * The pair `[first, second]` that a double loop over `jsonEqual` finds in `list`: the lowest index that has a later equal
 * item, and the lowest later index equal to it; `undefined` when all items differ. A short list of primitives is a double
 * loop over `===`. Any other list takes one pass, linear in the size of the items, and no hash, which a crafted list could
 * make collide into the quadratic search:
 * - A primitive is its own key in a `Map`, so `0` and `-0` meet and `1` and `'1'` do not; `NaN` equals nothing.
 * - An object already seen in the list is a duplicate at once.
 * - Any other object, array or date gets a `shallowKey`, which equal items always share. Items that share an exact key are
 *   equal; an item alone under its key is unique and is never walked. Only the items of a group of two or more inexact
 *   keys go through a `KeyWalk`, which tells equal items by the references of their members.
 * Each of these steps finds pairs `(first, later)`; the answer is the lowest `first`, then the lowest `later`. Every pair
 * of equal items falls in one group, so the best pair of all groups is the best pair of the list.
 */
export function duplicateItems(list: readonly unknown[]): readonly [first: number, second: number] | undefined {
  if (list.length <= PAIRWISE_ITEMS && !holdsObject(list)) {
    for (let first = 0; first < list.length - 1; first++) {
      for (let second = first + 1; second < list.length; second++) {
        if ((list[first] ?? null) === (list[second] ?? null)) return [first, second];
      }
    }
    return undefined;
  }
  let firstOf: Map<unknown, number> | undefined;
  const seen = new Map<object, number>();
  // The first index of an exact key, or the indexes of an inexact key once a second item has it.
  const shallow = new Map<string, number | number[]>();
  // The lengths are the "none yet" pair: any real index is lower.
  let first = list.length;
  let second = list.length;
  for (let index = 0; index < list.length; index++) {
    // The JSON view of an `undefined` item is `null`.
    const item = list[index] ?? null;
    let earlier: number | undefined;
    if (typeof item !== 'object' || item === null) {
      if (item !== item) continue;
      earlier = (firstOf ??= new Map()).get(item);
      if (earlier === undefined) firstOf.set(item, index);
    } else if ((earlier = seen.get(item)) === undefined) {
      seen.set(item, index);
      const key = shallowKey(item);
      const entry = shallow.get(key);
      if (entry === undefined) shallow.set(key, index);
      else if (typeof entry !== 'number') entry.push(index);
      else if (key.charCodeAt(0) === EXACT) earlier = entry;
      else shallow.set(key, [entry, index]);
    }
    if (earlier !== undefined && (earlier < first || (earlier === first && index < second))) {
      first = earlier;
      second = index;
    }
  }
  let walk: KeyWalk | undefined;
  let firstOfReference: Map<string, number> | undefined;
  for (const group of shallow.values()) {
    if (typeof group === 'number') continue;
    for (const index of group) {
      const reference = (walk ??= new KeyWalk()).reference(list[index] as object);
      const earlier = (firstOfReference ??= new Map()).get(reference);
      if (earlier === undefined) firstOfReference.set(reference, index);
      else if (earlier < first || (earlier === first && index < second)) {
        first = earlier;
        second = index;
      }
    }
  }
  return first === list.length ? undefined : [first, second];
}

function holdsObject(list: readonly unknown[]): boolean {
  for (let index = 0; index < list.length; index++) {
    const item = list[index];
    if (typeof item === 'object' && item !== null) return true;
  }
  return false;
}

/** The first character, `e`, of a `shallowKey` that decides equality. */
const EXACT = 101;
/** The first character, `?`, of the text of a member that a `shallowKey` cannot decide. */
const UNDECIDED = 63;
const NO_NAMES: readonly string[] = [];

/**
 * The text of an object, array or date item that two equal items always share, written without descending: the sorted
 * present names, and each member in full when it is a primitive or a date, else as a marker of its kind. It starts with `e`
 * when it met no nested object, no `NaN`, no function and no invalid date: then equal keys mean equal items. Otherwise it
 * starts with `x`, and equal keys only put the items in one group.
 */
function shallowKey(item: object): string {
  if (item instanceof Date) {
    const time = item.getTime();
    return time === time ? `ed${time}` : 'x?D';
  }
  const list = Array.isArray(item) ? item : undefined;
  const names = list === undefined ? Object.keys(item).sort() : NO_NAMES;
  const size = list === undefined ? names.length : list.length;
  let exact = true;
  let text = '';
  for (let position = 0; position < size; position++) {
    let prefix = '';
    let member: unknown;
    if (list !== undefined) {
      member = list[position] ?? null;
    } else {
      const name = names[position]!;
      member = presentValue(item, name);
      if (member === undefined) continue;
      prefix = `${name.length}:${name}=`;
    }
    const part = shallowMember(member);
    if (part.charCodeAt(0) === UNDECIDED) exact = false;
    text += `${prefix}${part},`;
  }
  return `${exact ? 'e' : 'x'}${list === undefined ? '{' : '['}${text}`;
}

function shallowMember(member: unknown): string {
  const text = primitiveText(member);
  if (text !== undefined) return text;
  if (member instanceof Date) return dateText(member) ?? '?D';
  return typeof member !== 'object' ? '?x' : Array.isArray(member) ? '?[' : '?{';
}

/** The text of a member that is no object, or `null`; `undefined` for `NaN`, a function and a symbol, which no text can decide. */
function primitiveText(member: unknown): string | undefined {
  switch (typeof member) {
    case 'string': return `s${member.length}:${member}`;
    case 'number': return member === member ? `n${member}` : undefined;
    case 'boolean': return member ? 't' : 'f';
    case 'bigint': return `b${member}`;
    case 'object': return member === null ? 'z' : undefined;
    default: return undefined;
  }
}

function dateText(date: Date): string | undefined {
  const time = date.getTime();
  return time === time ? `d${time}` : undefined;
}

/** An array or object being walked: its members are read from `index`, and `text` holds the references of the members read so far. */
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

/**
 * The references of the objects of one `duplicateItems` call. A reference is a short text, and two objects have one reference
 * exactly when `jsonEqual` calls them equal:
 * - A finished object gets the number of its text, `#n`. The text holds the references of its members, not their text, so
 *   each distinct object is walked once, a text stays short at any depth, and a value that shares members does not grow.
 * - An object that equals only itself gets an identity, `@n`: one that holds a `NaN` or an invalid date (`jsonEqual` accepts
 *   them only as the same object), and one that a cycle leads back to. `jsonEqual` calls two distinct cyclic values equal
 *   only if the walk ends at a shared object, else it does not end; so a value on a cycle equals only itself here. Hence one
 *   edge case differs from `jsonEqual`: two distinct objects that hold one cycle member through a back edge are not called
 *   equal, though `jsonEqual` would; only program values, never parsed input, can hold a cycle.
 * A function and a symbol also have an identity. Strings and names carry their length, so no text can forge the structure around it.
 * The walk keeps its own stack of frames, so an item nested to any depth needs no deep call stack.
 */
class KeyWalk {
  private readonly finished = new Map<object, string>();
  private readonly numbers = new Map<string, string>();
  private readonly identities = new Map<unknown, number>();
  private readonly onPath = new Set<object>();
  private readonly cyclic = new Set<object>();

  /** The reference of `root`, an array, an object or a date. */
  reference(root: object): string {
    const known = this.finished.get(root);
    if (known !== undefined) return known;
    if (root instanceof Date) return this.dateReference(root);
    const stack = [this.open(root, '')];
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
          const text = primitiveText(member);
          if (text !== undefined) frame.text += `${prefix}${text},`;
          else if (typeof member === 'number') frame.failed = true;
          else frame.text += `${prefix}${this.identity(member)},`;
        } else if (member instanceof Date) {
          frame.text += `${prefix}${this.dateReference(member)},`;
        } else if (this.finished.has(member)) {
          frame.text += `${prefix}${this.finished.get(member)},`;
        } else if (this.onPath.has(member)) {
          this.cyclic.add(member);
          frame.text += `${prefix}${this.identity(member)},`;
        } else {
          inner = member;
          stack.push(this.open(member, prefix));
        }
      }
      if (inner !== undefined) continue;
      stack.pop();
      this.onPath.delete(frame.value);
      const reference = this.close(frame);
      this.finished.set(frame.value, reference);
      const parent = stack[stack.length - 1];
      if (parent === undefined) return reference;
      parent.text += `${frame.prefix}${reference},`;
    }
  }

  private open(value: object, prefix: string): KeyFrame {
    this.onPath.add(value);
    return Array.isArray(value) ? new KeyFrame(value, prefix, value, NO_NAMES) : new KeyFrame(value, prefix, undefined, Object.keys(value).sort());
  }

  private close(frame: KeyFrame): string {
    if (frame.failed || this.cyclic.has(frame.value)) return this.identity(frame.value);
    const text = `${frame.text}${frame.list === undefined ? '}' : ']'}`;
    let reference = this.numbers.get(text);
    if (reference === undefined) {
      reference = `#${this.numbers.size}`;
      this.numbers.set(text, reference);
    }
    return reference;
  }

  private dateReference(date: Date): string {
    return dateText(date) ?? this.identity(date);
  }

  private identity(member: unknown): string {
    let id = this.identities.get(member);
    if (id === undefined) {
      id = this.identities.size;
      this.identities.set(member, id);
    }
    return `@${id}`;
  }
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
