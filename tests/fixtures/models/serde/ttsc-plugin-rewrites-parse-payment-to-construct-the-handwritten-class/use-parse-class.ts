import { parse, fromWireFormat } from '@exprtlabs/codegen/serde';
import { Payment, type TPayment } from './money.model.js';
export const parsed = parse<Payment>('{"id":"1","amount":{"currency":"USD","value":"1"},"note":"ok"}');
export const trusted = parse<Payment>('{"id":"1","amount":{"currency":"USD","value":"1"},"note":"ok"}', { validate: false });
export const typed = parse<TPayment>('{"id":"1","amount":{"currency":"USD","value":"1"},"note":"ok"}');
export const wrapped = new Payment(parse<TPayment>('{"id":"1","amount":{"currency":"USD","value":"1"},"note":"ok"}'));
export const wire = fromWireFormat<Payment>({ id: '1', amount: { currency: 'USD', value: '1' }, note: 'ok' });