// #region iobject-json
import { parse, stringify } from '@exprtlabs/golem/serde';
import { validate } from '@exprtlabs/golem/validation';
import type { TMoney } from './estimate.model.js';

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
