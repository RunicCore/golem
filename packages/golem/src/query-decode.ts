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

/** The field value decoded to what `shape` declares; text that does not fit stays as it is. */
export function decodeQueryField(value: unknown, shape: QueryFieldShape): unknown {
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
