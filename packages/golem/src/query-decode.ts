/**
 * The rule that turns text into the scalar or array a field declares: a query string value, and the path, header and cookie text of an inbound
 * SDK request, decode through it. A value that does not fit stays text, so the validator reports it.
 */

import { parameterStyleRule, type ParameterLocation, type ParameterStyleRule } from './client-runtime/parameter-styles.js';
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

/** Where a parameter is: its place in the request, and its name. */
export interface ParameterPlace {
  readonly location: ParameterLocation;
  readonly name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The items of a text that joins them; empty text has none. */
function splitText(text: string, separator: string): string[] {
  return text === '' ? [] : text.split(separator);
}

/**
 * The text of a label (`.1.2`) or matrix (`;id=1,2`, `;a=1;b=x`) parameter without its prefix; the items of an array that repeats `;name=`.
 * Undefined when the text does not have the style, so the validator reports it.
 */
function readPrefix(text: string, prefix: 'label' | 'matrix', name: string, rule: ParameterStyleRule, kind: 'array' | 'object' | 'value'): string | string[] | undefined {
  if (prefix === 'label') return text.startsWith('.') ? text.slice(1) : undefined;
  if (kind === 'object' && rule.explode) return text.startsWith(';') ? text.slice(1) : undefined;
  const lead = `;${name}=`;
  if (kind === 'array' && rule.array.layout === 'repeated') {
    const entries = text.split(';').slice(1);
    return text.startsWith(';') && entries.every((entry) => entry.startsWith(`${name}=`)) ? entries.map((entry) => entry.slice(name.length + 1)) : undefined;
  }
  return text.startsWith(lead) ? text.slice(lead.length) : undefined;
}

/** The properties of an object written as text, `k,v,k,v` (flat) or `k=v,k=v` (keyed); undefined when the text is not written so. */
function parseObjectText(text: string, layout: 'flat' | 'keyed', separator: string): Record<string, string> | undefined {
  if (text === '') return {};
  const parts = text.split(separator);
  if (layout === 'keyed') {
    const pairs = parts.map((part) => (part.includes('=') ? ([part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)] as const) : undefined));
    return pairs.every((pair) => pair !== undefined) ? Object.fromEntries(pairs) : undefined;
  }
  return parts.length % 2 === 0 ? Object.fromEntries(Array.from({ length: parts.length / 2 }, (_, index) => [parts[2 * index]!, parts[2 * index + 1]!])) : undefined;
}

function decodeProperties(record: Record<string, unknown>, properties: Readonly<Record<string, QueryFieldShape>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, Object.hasOwn(properties, key) ? decodeQueryField(value, properties[key]!) : value]));
}

/**
 * The object that a parameter writes over the keys of its group (`keys`, and `deep` as `name[member]`), with those keys; undefined when none of its keys is there.
 * A `deep` parameter may also arrive as one nested object under its name.
 */
export function gatherObjectField(group: Readonly<Record<string, unknown>>, { location, name }: ParameterPlace, shape: QueryFieldShape): { readonly value: Record<string, unknown>; readonly keys: readonly string[] } | undefined {
  const { parameter, properties } = shape;
  const layout = parameter && properties ? parameterStyleRule(location, parameter.style, parameter.explode)?.object.layout : undefined;
  if (!properties || (layout !== 'keys' && layout !== 'deep')) return undefined;
  if (layout === 'deep' && isRecord(group[name])) return { value: group[name], keys: [name] };
  const keys = layout === 'deep'
    ? Object.keys(group).filter((key) => key.startsWith(`${name}[`) && key.endsWith(']'))
    : Object.keys(properties).filter((key) => Object.hasOwn(group, key));
  if (keys.length === 0) return undefined;
  const member = (key: string): string => (layout === 'deep' ? key.slice(name.length + 1, -1) : key);
  return { value: Object.fromEntries(keys.map((key) => [member(key), group[key]])), keys };
}

/** The value of a parameter field as its style writes it: the prefix off, the text split into items or members, and each decoded to the type it declares. */
function decodeParameter(value: unknown, shape: QueryFieldShape, { style, explode }: NonNullable<QueryFieldShape['parameter']>, { location, name }: ParameterPlace): unknown {
  const rule = parameterStyleRule(location, style, explode);
  if (rule === undefined) return value;
  const kind = shape.item !== undefined ? 'array' : shape.properties !== undefined ? 'object' : 'value';
  const own = { ...shape, parameter: undefined };
  if (isRecord(value)) return shape.properties ? decodeProperties(value, shape.properties) : value;
  if (kind === 'object' && typeof value === 'string') {
    const text = rule.prefix ? readPrefix(value, rule.prefix, name, rule, kind) : value;
    const { layout, separator } = rule.object.layout === 'flat' || rule.object.layout === 'keyed' ? rule.object : { layout: undefined, separator: ',' as const };
    const parsed = typeof text === 'string' && layout ? parseObjectText(text, layout, separator) : undefined;
    return parsed === undefined ? value : decodeProperties(parsed, shape.properties!);
  }
  if (kind === 'array' && (typeof value === 'string' || Array.isArray(value))) {
    const texts = (Array.isArray(value) ? value : [value]).map((entry) => (typeof entry === 'string' && rule.prefix ? readPrefix(entry, rule.prefix, name, rule, kind) : entry));
    if (texts.some((text) => text === undefined)) return value;
    const items = (texts as (string | string[])[]).flat().flatMap((text) => (rule.array.layout === 'joined' ? splitText(text, rule.array.separator) : [text]));
    return decodeQueryItems(items, shape.item!);
  }
  if (kind === 'value' && typeof value === 'string' && rule.prefix) {
    const text = readPrefix(value, rule.prefix, name, rule, kind);
    return typeof text === 'string' ? decodeQueryField(text, own) : value;
  }
  return decodeQueryField(value, own);
}

/** The field value decoded to what `shape` declares; text that does not fit stays as it is. */
export function decodeQueryField(value: unknown, shape: QueryFieldShape, place?: ParameterPlace): unknown {
  if (shape.parameter !== undefined && place !== undefined) return decodeParameter(value, shape, shape.parameter, place);
  if (Array.isArray(value)) return shape.item ? decodeQueryItems(value, shape.item) : value;
  if (typeof value !== 'string') return value;
  const decoded = decodeQueryScalar(value, shape);
  if (decoded !== NOT_DECODED) return decoded;
  // A single occurrence of a repeatable key arrives as a string.
  return shape.item ? decodeQueryItems([value], shape.item) : value;
}
