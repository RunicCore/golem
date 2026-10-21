import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TMoney } from './payment.model.js';

declare const text: string;
export const money = parse<TMoney>(text);
export const written = stringify<TMoney>({ currency: 'USD', value: '1' });
