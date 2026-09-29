import { parse as readPayment } from '@exprtlabs/codegen/serde';
import { Payment } from './money.model.js';
export function parse(value: string): string { return value; }
export const kept = parse('plain');
export const parsed = readPayment<Payment>('{"id":"1","amount":{"currency":"USD","value":"1"},"note":"ok"}');