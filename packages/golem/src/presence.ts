/**
 * The JSON view of a field, as `JSON.stringify` writes it: a field is present when it is an own enumerable property
 * whose value is not `undefined`. Every read that judges input uses this one rule: the runtime calls `presentValue`,
 * and the emitters write the same read with `presentValueSource`.
 */
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

/** The value of an own enumerable field, read once; `undefined` for any other key. */
export function presentValue(value: object, key: string): unknown {
  return propertyIsEnumerable.call(value, key) ? Reflect.get(value, key) : undefined;
}

/** Source text of `presentValue`: `object` and `key` are expressions, and `read` reads the field from `object`. */
export function presentValueSource(object: string, key: string, read: string): string {
  return `Object.prototype.propertyIsEnumerable.call(${object}, ${key}) ? ${read} : undefined`;
}
