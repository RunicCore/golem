import { MODEL_FIELDS_KEY } from './schema-keywords.js';

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

const fieldsKey = Symbol.for(MODEL_FIELDS_KEY);

/**
 * The names that the own model of a golem model instance declares, or `undefined` when the value holds no program
 * state. `instanceFieldsSource` is the same walk as source text for the generated validators.
 */
export function instanceFields(value: object): readonly string[] | undefined {
  let prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype) return undefined;
  for (; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    if (Object.prototype.hasOwnProperty.call(prototype, fieldsKey)) return prototype[fieldsKey] ?? undefined;
  }
  return undefined;
}

/**
 * `value` as data to write: the value itself, or a copy in which every golem model instance, at any depth in arrays and
 * objects, keeps only the own keys that its model declares. An own key outside them is program state, which no codec
 * writes. A value with no model instance inside is returned as it is, and so is an object with its own JSON form (a
 * date, which has a `toJSON` method, or a typed array). A value that holds itself is left for the JSON writer to refuse.
 */
export function withoutInstanceState<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object') return value;
  return withoutInstanceStateAt(value, new Set()) as Value;
}

function withoutInstanceStateAt(value: object, ancestors: Set<object>): object {
  if (ancestors.has(value)) return value;
  if (Array.isArray(value)) {
    ancestors.add(value);
    let copy: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const element: unknown = value[index];
      const written = element !== null && typeof element === 'object' ? withoutInstanceStateAt(element, ancestors) : element;
      if (written !== element) copy ??= value.slice();
      if (copy !== undefined) copy[index] = written;
    }
    ancestors.delete(value);
    return copy ?? value;
  }
  const declared = instanceFields(value);
  if (declared === undefined && (ArrayBuffer.isView(value) || typeof Reflect.get(value, 'toJSON') === 'function')) return value;
  ancestors.add(value);
  let copy: Record<string, unknown> | undefined = declared === undefined
    ? undefined
    : Object.fromEntries(Object.entries(value).filter(([key]) => declared.includes(key)));
  for (const [key, child] of Object.entries(copy ?? value)) {
    if (child === null || typeof child !== 'object') continue;
    const written = withoutInstanceStateAt(child, ancestors);
    if (written === child) continue;
    copy ??= { ...value };
    copy[key] = written;
  }
  ancestors.delete(value);
  return copy ?? value;
}

/**
 * Source text of `instanceFields(value)`: the names that the own model of a golem model instance declares, or
 * `undefined` when the value holds no program state. The nearest prototype that owns a field entry decides, also when
 * the entry is `null` (a model that allows additional keys has no program state). A plain value, or a model of an older
 * runtime, has no entry. An own key outside the names is program state, never an unknown key. A loop reads the names
 * once for the object; the failure places ask `isInstanceState(value, key)` once for a key.
 */
export function instanceFieldsSource(): string {
  return [
    `const fieldsKey = /*#__PURE__*/ Symbol.for(${JSON.stringify(MODEL_FIELDS_KEY)});`,
    'function instanceFields(value) {',
    '  let prototype = Object.getPrototypeOf(value);',
    '  if (prototype === Object.prototype) return undefined;',
    '  for (; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {',
    '    if (Object.prototype.hasOwnProperty.call(prototype, fieldsKey)) return prototype[fieldsKey] ?? undefined;',
    '  }',
    '  return undefined;',
    '}',
  ].join('\n');
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
