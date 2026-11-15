/** Whether `value` is a plain-shaped record: an object that is not `null` and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `value` when it is a record, else `undefined`: a lookup that reads a field of unknown input narrows it here. */
export function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
