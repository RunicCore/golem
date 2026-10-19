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

/**
 * Source text that reads the declared keys of `object` in one `Object.keys` pass, the fastest exact form of the JSON
 * view (presence rows of scripts/benchmark/validator-toggles.ts). Each `[key, local]` pair gets the key's value in a new
 * `let` local, or `undefined` when the key is absent, so each field is read once. `declare` writes the declaration of
 * a local, for example with a type annotation.
 */
export function presentKeysSource(
  object: string,
  captures: readonly (readonly [key: string, local: string])[],
  declare: (local: string) => string = local => local,
): string {
  const cases = captures.map(([key, local]) => `case ${JSON.stringify(key)}: ${local} = ${object}[${JSON.stringify(key)}]; break;`).join(' ');
  return `let ${captures.map(([, local]) => declare(local)).join(', ')}; for (const __golemKey of Object.keys(${object})) switch (__golemKey) { ${cases} }`;
}
