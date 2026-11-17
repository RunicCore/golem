import { isRecord } from '@exprtlabs/golem/internal/generator-support';

/** Readers for parsed JSON. `JSON.parse` returns `any`; each reader checks one level and returns its type, so a test names no shape it did not check. */

export type JsonObject = { readonly [key: string]: unknown };

export function expectJsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`Expected ${label} to be a JSON object.`);
  return value;
}

export function expectJsonArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be a JSON array.`);
  return value;
}

export function expectJsonString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Expected ${label} to be a JSON string.`);
  return value;
}

/** The value that `steps` reach below `value`: a key of an object or an index of an array at each step. A step that the value cannot take throws. */
export const valueAt = (value: unknown, ...steps: readonly (string | number)[]): unknown =>
  steps.reduce((current, step) => typeof step === 'number' ? expectJsonArray(current, `[${step}]`)[step] : expectJsonObject(current, step)[step], value);
