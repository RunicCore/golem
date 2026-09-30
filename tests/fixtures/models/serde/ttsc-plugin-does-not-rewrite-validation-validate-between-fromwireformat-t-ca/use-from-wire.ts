import { fromWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import type { TMoney } from './money.model.js';
import './money.model.js';
export const first = fromWireFormat<TMoney>({ currency: 'USD', value: '1' });
export const check = (value: TMoney) => validateInstance(value);
export const second = fromWireFormat<TMoney>({ currency: 'EUR', value: '2' });