/**
 * Stable key for a JSON-like value: object keys are sorted at every depth.
 * It imports no other tooling module, so schema.ts and validation-tags.ts can
 * both use it without importing each other.
 */

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

/** Stable key used when deduplicating equivalent generated tag schemas. */
export function canonicalSchemaKey(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
