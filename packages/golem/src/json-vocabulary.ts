/**
 * What the generators and the validator compiler share about JSON and JSON Schema: where a schema keyword holds
 * subschemas, and the kind of a JSON value. Kept apart from the runtime modules, which never load it.
 */
import type { JsonValue } from './errors.js';
import type { DiscriminatorValue } from './model-registry.js';

/** The schema keywords whose value is a map from a name to a schema. */
export const SCHEMA_MAP_KEYWORDS: readonly string[] = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];

/** The schema keywords whose value is one schema. */
export const SCHEMA_SINGLE_KEYWORDS: readonly string[] = [
  'items', 'additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else',
  'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'contentSchema',
];

/** The schema keywords whose value is a list of schemas. */
export const SCHEMA_ARRAY_KEYWORDS: readonly string[] = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

/** The kinds of a JSON value. An integer is a `number`; a reader that splits the two tests `Number.isInteger` itself. */
export const JSON_KINDS = ['string', 'number', 'boolean', 'null', 'object', 'array'] as const;

export type JsonKind = (typeof JSON_KINDS)[number];

/** The kind of a parsed value; undefined for a value that JSON cannot hold (`undefined`, a bigint, a function, a symbol). */
export function jsonKindOf(value: JsonValue): JsonKind;
export function jsonKindOf(value: unknown): JsonKind | undefined;
export function jsonKindOf(value: unknown): JsonKind | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return undefined;
  }
}

/** Whether `value` can be the tag value of a union variant. */
export function isDiscriminatorValue(value: unknown): value is DiscriminatorValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
