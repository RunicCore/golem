import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TPaymentBaseModel } from './payment.model.generated.js';
export type TPaymentInput = IObject<{ note: string }>;
export type TPaymentFilter = IObject<{ limit?: string }>;
export type TPayment = IModel<{ id: string; note: string }>;
export class Payment extends TPaymentBaseModel {}