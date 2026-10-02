import { assertValue, fromWireFormat, parse, stringify, toWireFormat } from '@exprtlabs/golem/serde';
import { validate } from '@exprtlabs/golem/validation';
import type { TMoney } from './payment.model.js';

declare const money: TMoney;
declare const text: string;
export const written = stringify<TMoney>(money);
export const parsed = parse<TMoney>(text);
export const checked = validate<TMoney>(money);
export const asserted = assertValue<TMoney>(money);
export const wire = toWireFormat<TMoney>(money);
export const read = fromWireFormat<TMoney>(text);
