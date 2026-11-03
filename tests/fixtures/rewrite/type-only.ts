import { parse } from '@exprtlabs/golem/serde';
import type { Payment } from './payment.model.js';
import { type Ledger as Book } from './ledger.model.js';

declare const text: string;
export const payment = parse<Payment>(text);
export const book = parse<Book>(text, { validate: false });
export const again = parse<Payment>(text);
