import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './payment.model.js';

declare function stringify<T>(value: T): string;
declare const text: string;
export const local = stringify<TMoney>({ currency: 'USD', value: '1' });
export const json = JSON.parse(text) as TMoney;
export const comment = 'parse<TMoney>(text)'; // parse<TMoney>(text)
export const noTypeArgument = parse(text);
