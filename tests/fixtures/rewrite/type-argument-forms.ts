import { parse } from '@exprtlabs/golem/serde';
import * as models from './payment.model.js';
import { Payment } from './payment.model.js';

declare const text: string;
export const queried = parse<typeof Payment>(text);
export const qualified = parse<models.TMoney>(text);
export const qualifiedClass = parse<models.Payment>(text);
