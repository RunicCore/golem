import { stableValue } from './generator-core.js';

/** Stable key used when deduplicating equivalent generated tag schemas: the JSON text of the value with its object keys sorted at every depth. */
export function canonicalSchemaKey(value: unknown): string {
  return JSON.stringify(stableValue(value));
}
