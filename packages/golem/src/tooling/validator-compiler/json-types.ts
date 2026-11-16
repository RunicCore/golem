import { code, type Code } from '../code.js';
import type { IrTypeName } from './ir.js';
import { localName } from './local-helpers.js';

/**
 * The test of each JSON type, once as a value check (lowering) and once as the code the validator writes. The order of the
 * entries is the order of the type names in an issue and in a union's type dispatch.
 */
export const JSON_TYPES: Readonly<Record<IrTypeName, { readonly test: (value: unknown) => boolean; readonly code: (value: Code) => Code }>> = {
  null: { test: value => value === null, code: value => code`${value} === null` },
  boolean: { test: value => typeof value === 'boolean', code: value => code`typeof ${value} === 'boolean'` },
  // JSON has no NaN or infinity; a model value that holds one is not a number.
  number: { test: value => typeof value === 'number' && Number.isFinite(value), code: value => code`(typeof ${value} === 'number' && Number.isFinite(${value}))` },
  // A JSON number is a double, so an integer beyond Number.MAX_SAFE_INTEGER has already been rounded when it is read.
  integer: { test: value => Number.isSafeInteger(value), code: value => code`(typeof ${value} === 'number' && Number.isSafeInteger(${value}))` },
  string: { test: value => typeof value === 'string', code: value => code`typeof ${value} === 'string'` },
  array: { test: value => Array.isArray(value), code: value => code`Array.isArray(${value})` },
  object: { test: value => typeof value === 'object' && value !== null && !Array.isArray(value), code: value => code`${localName('isObject')}(${value})` },
};

/** True when `value` names a type that a JSON Schema `type` keyword can test. */
export function isTypeName(value: unknown): value is IrTypeName {
  return typeof value === 'string' && Object.hasOwn(JSON_TYPES, value);
}

/** Every type name of `JSON_TYPES`, in its order. */
export const TYPE_NAMES: readonly IrTypeName[] = Object.keys(JSON_TYPES).filter(isTypeName);

/** The type names of every JSON value (`integer` is a number), which a hole in an array is none of. */
export const JSON_TYPE_NAMES: readonly IrTypeName[] = TYPE_NAMES.filter(name => name !== 'integer');

/** The test that tells the JSON type of a value for a union; a `number` branch tests finiteness itself. */
export function dispatchTest(name: IrTypeName, value: Code): Code {
  return name === 'number' ? code`typeof ${value} === 'number'` : JSON_TYPES[name].code(value);
}
