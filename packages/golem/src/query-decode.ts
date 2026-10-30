/**
 * The rule that turns text into the scalar or array a field declares: a query string value, and the path, header and cookie text of an inbound
 * SDK request, decode through it. A value that does not fit stays text, so the validator reports it.
 */

import type { QueryFieldShape } from './object-codec.js';

const NOT_DECODED = Symbol('not decoded');
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function decodeQueryScalar(text: string, shape: QueryFieldShape): unknown {
  const literals = shape.literals ?? [];
  if (shape.types.includes('string') || literals.includes(text)) return text;
  const literal = literals.find((value) =>
    (typeof value === 'number' || typeof value === 'boolean') && String(value) === text);
  if (literal !== undefined) return literal;
  if ((shape.types.includes('number') || shape.types.includes('integer')) && JSON_NUMBER.test(text)) {
    const value = Number(text);
    // A field that admits only integers keeps an integer outside the safe range as text: it would decode to a different value. A field that admits a number decodes it.
    if (shape.types.includes('number') || Number.isSafeInteger(value)) return value;
  }
  if (shape.types.includes('boolean') && (text === 'true' || text === 'false')) return text === 'true';
  return NOT_DECODED;
}

function decodeQueryItems(values: readonly unknown[], item: QueryFieldShape): unknown[] {
  return values.map((entry) => {
    if (typeof entry !== 'string') return entry;
    const decoded = decodeQueryScalar(entry, item);
    return decoded === NOT_DECODED ? entry : decoded;
  });
}

/** The items of the text of an array field: empty text is no item, the rest splits at `separator`. */
function splitItems(value: unknown, separator: string): unknown[] {
  if (typeof value !== 'string') return [value];
  return value === '' ? [] : value.split(separator);
}

type ObjectShape = NonNullable<QueryFieldShape['object']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The text of a path parameter in label (`.1.2`, `.1,2`) or matrix (`;id=1;id=2`, `;id=1,2`, `;a=1;b=x`) style without its prefixes, as the items of an array field or as the one text;
 * undefined when the text does not have the style, so the validator reports it.
 */
function readPathStyle(text: string, { style, explode, name }: NonNullable<QueryFieldShape['pathStyle']>, kind: 'array' | 'object' | 'value'): string | string[] | undefined {
  if (style === 'label') {
    if (!text.startsWith('.')) return undefined;
    const rest = text.slice(1);
    return kind === 'array' ? (rest === '' ? [] : rest.split(explode ? '.' : ',')) : rest;
  }
  const prefix = `;${name}=`;
  if (kind === 'object' && explode) return text.startsWith(';') ? text.slice(1) : undefined;
  if (kind !== 'array') return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
  if (!explode) return text.startsWith(prefix) ? text.slice(prefix.length).split(',') : undefined;
  const entries = text.split(';').slice(1);
  return text.startsWith(';') && entries.every((entry) => entry.startsWith(`${name}=`)) ? entries.map((entry) => entry.slice(name.length + 1)) : undefined;
}

/** The properties of an object written as text, `k,v,k,v` (flat) or `k=v,k=v` (keyed); undefined when the text is not written so. */
function parseObjectText(text: string, { layout, separator }: ObjectShape): Record<string, string> | undefined {
  if (text === '') return {};
  const parts = text.split(separator);
  if (layout === 'keyed') {
    const pairs = parts.map((part) => (part.includes('=') ? ([part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)] as const) : undefined));
    return pairs.every((pair) => pair !== undefined) ? Object.fromEntries(pairs) : undefined;
  }
  return parts.length % 2 === 0 ? Object.fromEntries(Array.from({ length: parts.length / 2 }, (_, index) => [parts[2 * index]!, parts[2 * index + 1]!])) : undefined;
}

function decodeProperties(record: Record<string, unknown>, { properties }: ObjectShape): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, Object.hasOwn(properties, key) ? decodeQueryField(value, properties[key]!) : value]));
}

/**
 * The object that a `keys` or `deep` parameter spreads over the keys of its group, with those keys; undefined when none of its keys is there.
 * A `deep` parameter may also arrive as one nested object under its name.
 */
export function gatherObjectField(group: Readonly<Record<string, unknown>>, name: string, object: ObjectShape): { readonly value: Record<string, unknown>; readonly keys: readonly string[] } | undefined {
  if (object.layout === 'deep' && isRecord(group[name])) return { value: group[name], keys: [name] };
  const keys = object.layout === 'deep'
    ? Object.keys(group).filter((key) => key.startsWith(`${name}[`) && key.endsWith(']'))
    : Object.keys(object.properties).filter((key) => Object.hasOwn(group, key));
  if (keys.length === 0) return undefined;
  const property = (key: string): string => (object.layout === 'deep' ? key.slice(name.length + 1, -1) : key);
  return { value: Object.fromEntries(keys.map((key) => [property(key), group[key]])), keys };
}

/** The field value decoded to what `shape` declares; text that does not fit stays as it is. */
export function decodeQueryField(value: unknown, shape: QueryFieldShape): unknown {
  if (shape.pathStyle !== undefined && typeof value === 'string') {
    const content = readPathStyle(value, shape.pathStyle, shape.item !== undefined ? 'array' : shape.object !== undefined ? 'object' : 'value');
    return content === undefined ? value : decodeQueryField(content, { ...shape, pathStyle: undefined });
  }
  if (shape.object !== undefined) {
    if (typeof value === 'string') {
      const parsed = shape.object.layout === 'flat' || shape.object.layout === 'keyed' ? parseObjectText(value, shape.object) : undefined;
      return parsed === undefined ? value : decodeProperties(parsed, shape.object);
    }
    return isRecord(value) ? decodeProperties(value, shape.object) : value;
  }
  if (shape.split !== undefined && shape.item && (typeof value === 'string' || Array.isArray(value))) {
    return decodeQueryItems((Array.isArray(value) ? value : [value]).flatMap((entry) => splitItems(entry, shape.split!)), shape.item);
  }
  if (Array.isArray(value)) return shape.item ? decodeQueryItems(value, shape.item) : value;
  if (typeof value !== 'string') return value;
  const decoded = decodeQueryScalar(value, shape);
  if (decoded !== NOT_DECODED) return decoded;
  // A single occurrence of a repeatable key arrives as a string.
  return shape.item ? decodeQueryItems([value], shape.item) : value;
}
