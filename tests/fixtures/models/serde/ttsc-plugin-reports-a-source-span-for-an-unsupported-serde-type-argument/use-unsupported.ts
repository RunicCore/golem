import { stringify } from '@exprtlabs/codegen/serde';
import type { TMoney } from './money.model.js';
import './money.model.js';
export const text = stringify<Partial<TMoney>>({ currency: 'USD', value: '1' });