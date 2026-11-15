/** The OpenAPI versions that a docs job can write. */
export type OpenApiVersion = '3.2.0' | '3.1.2';

/** The version of a docs job: `value` is what the user set, `field` names it in the error; a missing value is 3.2.0. */
export function openApiVersionOf(value: unknown, field: string): OpenApiVersion {
  if (value === undefined) return '3.2.0';
  if (value === '3.2.0' || value === '3.1.2') return value;
  throw new TypeError(`${field} must be 3.2.0 or 3.1.2.`);
}
