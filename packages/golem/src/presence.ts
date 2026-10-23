import { conversionError } from './conversion-error.js';
import { LibErrorKind } from './errors.js';
import { MODEL_FIELDS_KEY } from './schema-keywords.js';

/**
 * The JSON view of a field, as `JSON.stringify` writes it: a field is present when it is an own enumerable property
 * whose value is not `undefined`. Every read that judges input uses this one rule: the runtime calls `presentValue`,
 * and the emitters write the same read with `presentValueCode` (tooling/union-conversion.ts).
 */
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

/** The value of an own enumerable field, read once; `undefined` for any other key. */
export function presentValue(value: object, key: string): unknown {
  return propertyIsEnumerable.call(value, key) ? Reflect.get(value, key) : undefined;
}

const fieldsKey = Symbol.for(MODEL_FIELDS_KEY);

/**
 * The names that the own model of a golem model instance declares, or `undefined` when the value holds no program
 * state. `instanceFieldsCode` (tooling/union-conversion.ts) is the same walk as code for the generated validators.
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
 * date, which has a `toJSON` method, or a typed array). A value that holds itself throws a `Serialization` error, which is not caused by input.
 */
export function withoutInstanceState<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object') return value;
  return withoutInstanceStateAt(value, new Set()) as Value;
}

function withoutInstanceStateAt(value: object, ancestors: Set<object>): object {
  if (ancestors.has(value)) throw conversionError(LibErrorKind.Serialization, 'Cyclic values cannot be encoded.');
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
