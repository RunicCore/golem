
import type { IModel } from '@exprtlabs/golem/model';
import { PaymentDomainBase } from './payment.base.js';

export type TPayment = IModel<{ id: string }>;
export class Payment extends PaymentDomainBase {}
