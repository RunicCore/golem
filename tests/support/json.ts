/** Readers for parsed JSON. `JSON.parse` returns `any`; each reader checks one level and returns its type, so a test names no shape it did not check. */

export type JsonObject = { readonly [key: string]: unknown };

export function expectJsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected ${label} to be a JSON object.`);
  return value as JsonObject;
}

export function expectJsonArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be a JSON array.`);
  return value;
}

export function expectJsonString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Expected ${label} to be a JSON string.`);
  return value;
}
