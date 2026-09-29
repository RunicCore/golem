// #region iobject-json
import { parse, stringify } from '@exprtlabs/codegen/serde';
import { validate } from '@exprtlabs/codegen/validation';
import type { TMoney } from './money.model.js';
// Bare import: the generated file's module-scope code registers TMoney's codec.
import './money.model.generated.js';

export function readMoney(text: string): TMoney {
  return parse<TMoney>(text); // plain object, validated
}

export function writeMoney(money: TMoney): string {
  return stringify<TMoney>(money);
}

export function isMoney(value: unknown): value is TMoney {
  return validate<TMoney>(value); // for data you did not parse yourself
}
// #endregion iobject-json
