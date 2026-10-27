import { code, type Code } from '../code.js';
import type { IrTypeName } from './ir.js';
import { localName } from './local-helpers.js';

/** The test of each JSON type, once as a value check (lowering) and once as the code the validator writes. */
export const JSON_TYPES: Readonly<Record<IrTypeName, { readonly test: (value: unknown) => boolean; readonly code: (value: Code) => Code }>> = {
  string: { test: value => typeof value === 'string', code: value => code`typeof ${value} === 'string'` },
  // JSON has no NaN or infinity; a model value that holds one is not a number.
  number: { test: value => typeof value === 'number' && Number.isFinite(value), code: value => code`(typeof ${value} === 'number' && Number.isFinite(${value}))` },
  integer: { test: value => Number.isInteger(value), code: value => code`Number.isInteger(${value})` },
  boolean: { test: value => typeof value === 'boolean', code: value => code`typeof ${value} === 'boolean'` },
  null: { test: value => value === null, code: value => code`${value} === null` },
  object: { test: value => typeof value === 'object' && value !== null && !Array.isArray(value), code: value => code`${localName('isObject')}(${value})` },
  array: { test: value => Array.isArray(value), code: value => code`Array.isArray(${value})` },
};

/** The test that tells the JSON type of a value for a union; a `number` branch tests finiteness itself. */
export function dispatchTest(name: IrTypeName, value: Code): Code {
  return name === 'number' ? code`typeof ${value} === 'number'` : JSON_TYPES[name].code(value);
}
