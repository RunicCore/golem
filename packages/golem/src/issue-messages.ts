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
    case 'type': return `Expected ${describeList(detail.expected, 'or')}${detail.expected.includes('integer')
      ? ': an integer must lie within ±9007199254740991, because JSON numbers in JavaScript cannot carry a larger integer exactly'
      : ''}`;
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
    case 'format': return detail.format === 'int64'
      ? 'Must be a valid int64 within ±9007199254740991, because JSON numbers in JavaScript cannot carry a larger integer exactly'
      : `Must be a valid ${detail.format}`;
    case 'multipleOf': return `Must be a multiple of ${detail.divisor}`;
    case 'unique': return `Items at index ${detail.indexes[0]} and ${detail.indexes[1]} are equal; items must be unique`;
    case 'not': return 'Must not match the excluded shape';
    case 'never': return 'No value is allowed here';
    case 'custom': return detail.reason ?? 'Invalid value';
  }
}
