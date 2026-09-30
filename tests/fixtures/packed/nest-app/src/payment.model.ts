import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { Integer, MaxLength, Minimum, MinLength, Pattern } from '@exprtlabs/golem/tags';
import type { PaymentStatus } from './payment-status.js';

export type TMerchant = IObject<{ id: string; name: string & MinLength<2> }>;
export type TMoney = IObject<{
  amount: string & Pattern<'^[0-9]+(?:\\.[0-9]{1,2})?$'>;
  currency: 'USD' | 'EUR';
}>;
export type TPayment = IModel<{
  id: string;
  merchant: TMerchant;
  billing: Omit<TMerchant, 'id'>;
  money: TMoney;
  note: string & MaxLength<140>;
}, { exact: true }>;
export type TPaymentInput = IObject<Omit<TPayment, 'id'>, { exact: true }>;
// exact: true rejects undeclared keys such as tracking=x with HTTP 400.
export type TPaymentFilter = IObject<{
  limit?: number & Integer & Minimum<1>;
  status?: PaymentStatus | PaymentStatus[];
}, { exact: true }>;

import { PaymentBase } from './payment.model.generated.js';

export class Payment extends PaymentBase {}
