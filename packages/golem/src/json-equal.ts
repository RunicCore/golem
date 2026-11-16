import { instanceFields, isStateKey, presentValue } from './presence.js';

/**
 * JSON Schema equality over the JSON view, as `JSON.stringify` writes a value: numbers by value; arrays by position,
 * with an `undefined` item and a hole equal to `null`; objects by their own enumerable keys whose value is not
 * `undefined`, in any order.
 */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!jsonEqual(left[index] ?? null, right[index] ?? null)) return false;
    }
    return true;
  }
  // Counts the keys of each side inline, so a comparison allocates no key list. Program state of a model instance is no key.
  const leftFields = instanceFields(left);
  const rightFields = instanceFields(right);
  let count = 0;
  for (const key in left) {
    if (isStateKey(leftFields, key)) continue;
    const value = presentValue(left, key);
    if (value === undefined) continue;
    const other = isStateKey(rightFields, key) ? undefined : presentValue(right, key);
    if (other === undefined || !jsonEqual(value, other)) return false;
    count++;
  }
  for (const key in right) {
    if (!isStateKey(rightFields, key) && presentValue(right, key) !== undefined) count--;
  }
  return count === 0;
}
