// The spellings of Nest URI versioning that the ts-openapi block takes. Nest itself defines only `VersioningType.URI`, the number 0; golem.yaml cannot name an enum member, so it also takes 'URI' and 'uri'. Plan validation and the controller analysis both ask this one predicate.
export const URI_VERSIONING_TYPES = ['URI', 'uri', 0] as const;

export type UriVersioningType = typeof URI_VERSIONING_TYPES[number];

export function isUriVersioningType(value: unknown): value is UriVersioningType {
  return URI_VERSIONING_TYPES.some(spelling => spelling === value);
}
