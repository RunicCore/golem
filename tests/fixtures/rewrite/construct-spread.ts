import { fromWireFormat, parse } from '@exprtlabs/golem/serde';
import { Payment, type TPayment } from './payment.model.js';

declare const text: string;
declare const pair: [string, { validate?: boolean }];
declare const options: [{ validate?: boolean }];
export const whole = parse<Payment>(...pair);
export const tail = parse<Payment>(text, ...options);
export const wire = fromWireFormat<Payment>(...pair);
export const plain = parse<TPayment>(...pair);
export const third = parse<Payment>(text, { validate: false }, ...options);
