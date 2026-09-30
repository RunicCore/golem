import { stringify } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
import './money.model.js';
export const text = stringify<
  TMoney
>({ currency: 'USD', value: '1' });