import { parse } from '@exprtlabs/golem/serde';
import type { PaymentInput } from './payment.model.js';
export function read(text: string): PaymentInput { return parse<PaymentInput>(text); }
