import { parse } from '@exprtlabs/golem/serde';
import { TPaymentBaseModel } from './payment.model.generated.js';
import { AdminPayment, Ledger, Payment } from './payment.model.js';

const wire = '{"id":"p","amount":1}';
export const plain = parse<Payment>(wire);
export const admin = parse<AdminPayment>(wire);
export const ledger = parse<Ledger>(`{"first":${wire},"second":${wire},"third":${wire}}`);
export const base = TPaymentBaseModel;
