import type { IModel, IObject } from '@exprtlabs/golem/model';
import { PaymentBase } from './payment.model.generated.js';
export type TPaymentInput = IObject<{ note: string }>;
export type PaymentInput = TPaymentInput;
export type TPaymentFilter = IObject<{ limit?: string }>;
export type PaymentFilter = TPaymentFilter;
export type TPayment = IModel<{ id: string; note: string }>;
export class Payment extends PaymentBase {}