import type { SchemaIssue } from './issue-messages.js';
import { instanceFields, isStateKey, presentValue } from './presence.js';
export type { SchemaIssue, SchemaIssueDetail } from './issue-messages.js';
export type { JsonValue } from './errors.js';
export { instanceFields, isStateKey };

/**
 * A generated validator; with `all` false it returns at the first issue. With `sanity` true it checks the shape only: it
 * skips the value limits and the validation functions. A validator of a sanity-only module takes no flag.
 */
export type Validator = (value: unknown, all: boolean, sanity?: boolean) => readonly SchemaIssue[];

/** What the keywords of one value evaluated: keys by name, or all of them; leading items by count, others by index, or all of them. */
export interface Evaluation {
  keys: Set<string>;
  allKeys: boolean;
  prefix: number;
  indexes: Set<number>;
  allItems: boolean;
}

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
    const [, whole, fraction = '', exponent = '0'] = /^-?([0-9]+)(?:[.]([0-9]+))?(?:e([+-][0-9]+))?$/.exec(String(number)) ?? [];
    if (whole === undefined) throw new RangeError(`${number} has no decimal text`);
    return [BigInt(whole + fraction), Number(exponent) - fraction.length];
  };
  const [valueDigits, valueExponent] = split(value);
  const [divisorDigits, divisorExponent] = split(divisor);
  const exponent = Math.min(valueExponent, divisorExponent);
  const scale = (shift: number): bigint => BigInt(10) ** BigInt(shift - exponent);
  return (valueDigits * scale(valueExponent)) % (divisorDigits * scale(divisorExponent)) === BigInt(0);
}

/** A list of at most this many primitives is compared pairwise: for a few items the double loop beats building a `Map`. */
const PAIRWISE_ITEMS = 6;

/**
 * The pair `[first, second]` that a double loop over `jsonEqual` finds in `list`: the lowest index that has a later equal
 * item, and the lowest later index equal to it; `undefined` when all items differ. A short list of primitives is a double
 * loop over `===`. Any other list takes one pass, linear in the size of the items, with keys that are exact texts, never a
 * hash function of golem's own, which a crafted list could make collide into the quadratic search:
 * - A primitive is its own key in a `Map`, so `0` and `-0` meet and `1` and `'1'` do not; `NaN` equals nothing.
 * - An object already seen in the list is a duplicate at once.
 * - Any other object, array or date gets a `shallowKey`, which equal items always share. An item alone under its key is
 *   unique and is never walked.
 * - The items that share a key go through rounds of `KeyWalk`, to a depth of 2, then 4, 8 and so on. An item alone under its
 *   key leaves. A key that met no depth limit is complete: its items are equal. So an item costs the depth at which it
 *   differs from its look-alikes, and two equal items cost their whole size.
 * Each step finds pairs `(first, later)`; the answer is the lowest `first`, then the lowest `later`. Every pair of equal
 * items falls in one group of every step, so the best pair of all groups is the best pair of the list.
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
  // The length is the "none yet" pair: any real index is lower.
  const found: [number, number] = [list.length, list.length];
  let firstOf: Map<unknown, number> | undefined;
  const seen = new Map<object, number>();
  const shallow = new Map<string, Group>();
  for (let index = 0; index < list.length; index++) {
    // The JSON view of an `undefined` item is `null`.
    const item = list[index] ?? null;
    if (typeof item !== 'object' || item === null) {
      if (item !== item) continue;
      const earlier = (firstOf ??= new Map()).get(item);
      if (earlier === undefined) firstOf.set(item, index);
      else lowerPair(found, earlier, index);
    } else {
      const earlier = seen.get(item);
      if (earlier !== undefined) {
        lowerPair(found, earlier, index);
      } else {
        seen.set(item, index);
        groupOf(shallow, shallowKey(item), index);
      }
    }
  }
  let pending: number[] = [];
  for (const group of shallow.values()) {
    if (typeof group !== 'number') for (const index of group) pending.push(index);
  }
  for (let depth = 2; pending.length > 0; depth *= 2) {
    const walk = new KeyWalk(depth);
    const byReference = new Map<string, Group>();
    for (const index of pending) groupOf(byReference, walk.reference(objectAt(list, index)), index);
    pending = [];
    for (const [reference, group] of byReference) {
      if (typeof group === 'number') continue;
      if (reference.charCodeAt(0) !== TRUNCATED) lowerPair(found, group[0], group[1]);
      else for (const index of group) pending.push(index);
    }
  }
  return found[0] === list.length ? undefined : found;
}

/** The object at `index`, which `duplicateItems` met as an object in its first pass. */
function objectAt(list: readonly unknown[], index: number): object {
  const item = list[index];
  if (typeof item !== 'object' || item === null) throw new TypeError(`Item ${index} is no object, but the first pass of duplicateItems met an object there.`);
  return item;
}

function holdsObject(list: readonly unknown[]): boolean {
  for (let index = 0; index < list.length; index++) {
    const item = list[index];
    if (typeof item === 'object' && item !== null) return true;
  }
  return false;
}

/** Notes that `later` is equal to the item at index `earlier`, when that pair is lower than `found`. */
function lowerPair(found: [number, number], earlier: number, later: number): void {
  if (earlier < found[0] || (earlier === found[0] && later < found[1])) {
    found[0] = earlier;
    found[1] = later;
  }
}

/** The indexes that share a key: the index itself while it is alone, then a list of at least two. */
type Group = number | [first: number, second: number, ...later: number[]];

/** Puts `index` under `key`: the index itself while it is alone, then the list of its indexes. */
function groupOf(groups: Map<string, Group>, key: string, index: number): void {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, index);
  else if (typeof group === 'number') groups.set(key, [group, index]);
  else group.push(index);
}

/** The first character, `~`, of a reference to a value that a depth limit cut short. */
const TRUNCATED = 126;
const NO_NAMES: readonly string[] = [];

/** An array or object being read, member by member. `text` holds what has been read; `label` is the name part of the last member read. */
class KeyFrame {
  index = 0;
  failed = false;
  truncated = false;
  label = '';
  text: string;
  readonly list: readonly unknown[] | undefined;
  readonly names: readonly string[];
  readonly size: number;

  /** `names` are the sorted own enumerable names of an object that is no array, without its program state. */
  constructor(readonly value: object) {
    this.list = Array.isArray(value) ? value : undefined;
    this.names = this.list === undefined ? dataNames(value).sort() : NO_NAMES;
    this.text = this.list === undefined ? '{' : '[';
    this.size = this.list === undefined ? this.names.length : this.list.length;
  }

  /** The member at `position` in the JSON view, or `undefined` when an object has no such present member. */
  read(position: number): unknown {
    if (this.list !== undefined) return this.list[position] ?? null;
    const name = this.names[position];
    if (name === undefined) throw new RangeError(`Position ${position} is past the ${this.names.length} names of the object.`);
    const member = presentValue(this.value, name);
    if (member !== undefined) this.label = `${name.length}:${name}=`;
    return member;
  }

  add(reference: string): void {
    this.text += `${this.label}${reference},`;
    if (reference.charCodeAt(0) === TRUNCATED) this.truncated = true;
  }
}

/** The own enumerable names of `value`, without the program state of a model instance. */
function dataNames(value: object): string[] {
  const names = Object.keys(value);
  const fields = instanceFields(value);
  return fields === undefined ? names : names.filter(name => !isStateKey(fields, name));
}

/**
 * A text that equal items always share, written without descending: the present names, and each member in full when it is
 * a primitive, else as a marker with the length of an array. Items with different texts are different.
 */
function shallowKey(item: object): string {
  if (item instanceof Date) return '{';
  const frame = new KeyFrame(item);
  for (let position = 0; position < frame.size; position++) {
    const member = frame.read(position);
    if (member === undefined) continue;
    frame.add(primitiveText(member) ?? (Array.isArray(member) ? `?${member.length}` : '?'));
  }
  return frame.text;
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

/**
 * The references of the objects of one round of `duplicateItems`, to a depth. A reference is a short text, and two items have
 * one reference exactly when `jsonEqual` calls them equal down to that depth:
 * - A finished object gets the number of its text, `#n`. The text holds the references of its members, not their text, so
 *   each distinct object is walked once at a depth, a text stays short, and a value that shares members does not grow.
 *   The memo holds the object and its depth: the same object met nearer the limit is cut shorter.
 * - An object at the depth `limit` is the token `~`, and an object whose text holds one is `~n`: the reference is cut short.
 * - An object that equals only itself gets an identity, `@n`: one that holds a `NaN` or an invalid date (`jsonEqual` accepts
 *   them only as the same object), and one that a cycle leads back to. `jsonEqual` calls two distinct cyclic values equal
 *   only if the walk ends at a shared object, else it does not end; so a member that a cycle leads back to equals only itself
 *   here. Hence one edge case differs from `jsonEqual`: two distinct members that hold one such cycle member are not called
 *   equal. An item is keyed by its own text even when a cycle leads back to it, so two items that hold one cycle member are.
 *   Only program values, never parsed input, can hold a cycle.
 * A function and a symbol also have an identity. Strings and names carry their length, so no text can forge the structure around it.
 * The walk keeps its own stack of frames, so an item nested to any depth needs no deep call stack.
 */
class KeyWalk {
  /** The references of the finished objects, one map for each depth, made when first needed. */
  private readonly finished: Map<object, string>[] = [];
  private readonly numbers = new Map<string, string>();
  private readonly identities = new Map<unknown, number>();
  private readonly onPath = new Set<object>();
  private readonly cyclic = new Set<object>();

  constructor(private readonly limit: number) {}

  /** The reference of `root`, an array, an object or a date. */
  reference(root: object): string {
    if (root instanceof Date) return dateText(root) ?? this.identity(root);
    const parents: KeyFrame[] = [];
    let frame = this.open(root);
    for (;;) {
      let inner: object | undefined;
      while (inner === undefined && !frame.failed && frame.index < frame.size) {
        const member = frame.read(frame.index++);
        if (member === undefined) continue;
        if (typeof member !== 'object' || member === null) {
          const text = primitiveText(member);
          if (text !== undefined) frame.add(text);
          else if (typeof member === 'number') frame.failed = true;
          else frame.add(this.identity(member));
          continue;
        }
        if (member instanceof Date) {
          frame.add(dateText(member) ?? this.identity(member));
        } else if (this.onPath.has(member)) {
          this.cyclic.add(member);
          frame.add(this.identity(member));
        } else if (parents.length + 1 === this.limit) {
          frame.add('~');
        } else {
          const known = this.finished[parents.length + 1]?.get(member);
          if (known !== undefined) {
            frame.add(known);
          } else {
            inner = member;
          }
        }
      }
      if (inner !== undefined) {
        parents.push(frame);
        frame = this.open(inner);
        continue;
      }
      this.onPath.delete(frame.value);
      const text = frame.failed ? undefined : this.number(frame);
      const reference = text === undefined || this.cyclic.has(frame.value) ? this.identity(frame.value) : text;
      const parent = parents.pop();
      if (parent === undefined) return text ?? reference;
      (this.finished[parents.length + 1] ??= new Map()).set(frame.value, reference);
      parent.add(reference);
      frame = parent;
    }
  }

  private open(value: object): KeyFrame {
    this.onPath.add(value);
    return new KeyFrame(value);
  }

  /** The number of the text of a frame that was read in full. */
  private number(frame: KeyFrame): string {
    const text = `${frame.text}${frame.list === undefined ? '}' : ']'}`;
    let reference = this.numbers.get(text);
    if (reference === undefined) {
      reference = `${frame.truncated ? '~' : '#'}${this.numbers.size}`;
      this.numbers.set(text, reference);
    }
    return reference;
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

function dateText(date: Date): string | undefined {
  const time = date.getTime();
  return time === time ? `d${time}` : undefined;
}

/** The validity of a `Date` binding: an instance can be a `Date` and hold no time (`new Date(NaN)`). */
export function hasFiniteTime(instance: Date): boolean {
  return Number.isFinite(instance.getTime());
}

/**
 * A test for the class at `path` below `globalThis` (`['Temporal', 'Instant']`), and for the function `valid`, which an instance must also
 * pass. The class is looked up on a call until it is found, because a polyfill may load after the validators: while it is missing, no value
 * is an instance of it. A found class is kept.
 */
export function globalInstanceTest<Instance extends object>(path: readonly string[], valid?: (instance: Instance) => boolean): (value: unknown) => boolean {
  let known: (new (...args: never[]) => Instance) | undefined;
  return (value) => {
    if (known === undefined) {
      let found: unknown = globalThis;
      for (const name of path) found = (found as Record<string, unknown> | undefined)?.[name];
      if (typeof found !== 'function') return false;
      known = found as new (...args: never[]) => Instance;
    }
    return value instanceof known && (valid === undefined || valid(value));
  };
}
