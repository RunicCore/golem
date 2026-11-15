/** The OpenAPI versions that a docs job can write. `golem-schema.json` lists the same versions for the editor. */
export const OPENAPI_VERSIONS = ['3.2.0', '3.1.2'] as const;

export type OpenApiVersion = typeof OPENAPI_VERSIONS[number];

/** The version of a docs job that sets none. */
export const DEFAULT_OPENAPI_VERSION: OpenApiVersion = '3.2.0';

/** The version of a docs job: `value` is what the user set, `field` names it in the error; a missing value is the default version. */
export function openApiVersionOf(value: unknown, field: string): OpenApiVersion {
  if (value === undefined) return DEFAULT_OPENAPI_VERSION;
  const version = OPENAPI_VERSIONS.find(known => known === value);
  if (version === undefined) throw new TypeError(`${field} must be ${OPENAPI_VERSIONS.join(' or ')}.`);
  return version;
}
