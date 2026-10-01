import type { IObject, IModel } from '@exprtlabs/golem/model';
import { PaymentBaseModel } from './money.model.generated.js';

export type TMoney = IObject<{ currency: string; value: string }>;
export type TPayment = IModel<{ id: string; amount: TMoney; note: string }>;
export class Payment extends PaymentBaseModel {}
