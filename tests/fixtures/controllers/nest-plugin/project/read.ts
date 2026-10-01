import { parse } from '@exprtlabs/golem/serde';
import type { TPaymentInput } from './payment.model.js';
export function read(text: string): TPaymentInput { return parse<TPaymentInput>(text); }
