import { parse } from '@exprtlabs/golem/serde';
import type * as models from './payment.model.js';
import type { Ledger } from './ledger.model.js';

declare const text: string;
export const payment = parse<models.Payment>(text);
export const options = parse<models.Payment>(text, { validate: false });
export const book = parse<Ledger>(text);
