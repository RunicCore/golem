import { parse } from '@exprtlabs/golem/serde';
import { Payment } from './payment.model.js';

class Sub extends Payment {}
const construct = Sub;
declare const text: string;
declare const options: { validate?: boolean; construct?: typeof Payment };
declare function pick(): { construct?: typeof Payment };
export const shorthand = parse<Payment>(text, { construct });
export const quoted = parse<Payment>(text, { 'construct': Sub });
export const computed = parse<Payment>(text, { ['construct']: Sub });
export const parenthesized = parse<Payment>(text, ({ validate: false, construct: Sub }));
export const commented = parse<Payment>(text, { validate: false /* construct: Sub */ });
export const quotedText = parse<Payment>(text, { validate: text === 'construct:' });
export const variable = parse<Payment>(text, options);
export const spread = parse<Payment>(text, { ...options, validate: false });
export const called = parse<Payment>(text, pick());
