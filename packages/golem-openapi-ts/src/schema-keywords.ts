/** The schema keywords whose value is a map from a name to a schema. */
export const SCHEMA_MAP_KEYWORDS: readonly string[] = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
];

/** The schema keywords whose value is one schema. */
export const SCHEMA_SINGLE_KEYWORDS: readonly string[] = [
  'items',
  'additionalProperties',
  'additionalItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
];

/** The schema keywords whose value is a list of schemas. */
export const SCHEMA_ARRAY_KEYWORDS: readonly string[] = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
