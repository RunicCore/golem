/** The rule that turns a query string value into the scalar or array a field declares. A value that does not fit stays text, so the validator reports it. */

/**
 * What a query string can carry for one field: the scalar types it admits, its literals, and the shape of an array item.
 * A tuple adds `prefix`, the shape of each listed position; `item` is then the rest rule for the entries after them.
 */
export interface QueryFieldShape {
  readonly types: readonly ('string' | 'number' | 'integer' | 'boolean')[];
  readonly literals?: readonly (string | number | boolean)[];
  readonly item?: QueryFieldShape;
  readonly prefix?: readonly QueryFieldShape[];
}

/** The fields of a model that a query string decodes, by name. */
export type QueryFieldTable = Readonly<Record<string, QueryFieldShape>>;

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

function decodeQueryItems(values: readonly unknown[], shape: QueryFieldShape): unknown[] {
  return values.map((entry, index) => {
    const item = shape.prefix?.[index] ?? shape.item;
    if (typeof entry !== 'string' || !item) return entry;
    const decoded = decodeQueryScalar(entry, item);
    return decoded === NOT_DECODED ? entry : decoded;
  });
}

/** The field value decoded to what `shape` declares; text that does not fit stays as it is. */
export function decodeQueryField(value: unknown, shape: QueryFieldShape): unknown {
  if (Array.isArray(value)) return shape.item || shape.prefix ? decodeQueryItems(value, shape) : value;
  if (typeof value !== 'string') return value;
  const decoded = decodeQueryScalar(value, shape);
  if (decoded !== NOT_DECODED) return decoded;
  // A single occurrence of a repeatable key arrives as a string.
  return shape.item || shape.prefix ? decodeQueryItems([value], shape) : value;
}
