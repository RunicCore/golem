// The spellings of Nest URI versioning that the ts-openapi block takes. Nest itself defines only `VersioningType.URI`, the number 0; golem.yaml cannot name an enum member, so it also takes 'URI' and 'uri'. Plan validation and the controller analysis both ask this one predicate.
export const URI_VERSIONING_TYPES = ['URI', 'uri', 0] as const;

export type UriVersioningType = typeof URI_VERSIONING_TYPES[number];

export function isUriVersioningType(value: unknown): value is UriVersioningType {
  return URI_VERSIONING_TYPES.some(spelling => spelling === value);
}

const SPELLINGS = URI_VERSIONING_TYPES.map(spelling => typeof spelling === 'string' ? `'${spelling}'` : String(spelling));

/** The set as a phrase for a message, `'URI', 'uri' or 0`, so a message lists what the predicate accepts. */
export const URI_VERSIONING_TYPES_PHRASE = `${SPELLINGS.slice(0, -1).join(', ')} or ${SPELLINGS.slice(-1).join('')}`;
