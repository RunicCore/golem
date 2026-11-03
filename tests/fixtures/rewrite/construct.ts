import { fromWireFormat, parse } from '@exprtlabs/golem/serde';
import { Payment, type TPayment } from './payment.model.js';

declare const text: string;
export const one = parse<Payment>(text);
export const two = parse<Payment>(text, { validate: false });
export const present = parse<Payment>(text, { construct: Payment });
export const wire = fromWireFormat<Payment>({ id: '1' });
export const plain = parse<TPayment>(text);
export const nested = parse<Payment>(text, { validate: parse<TPayment>(text) === undefined });
