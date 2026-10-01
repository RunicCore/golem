import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { Integer, MaxLength, Minimum, MinLength, Pattern } from '@exprtlabs/golem/tags';
import type { PaymentStatus } from './payment-status.js';
import { PaymentBaseModel } from './payment.model.generated.js';

// #region payment-types
export type TMerchant = IObject<{ id: string; name: string & MinLength<2> }>;
// Amount is a decimal string on the wire, not a number.
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
// #endregion payment-types
// #region payment-filter
// Query object: NestModelInterceptor decodes limit to a number before validation;
// repeated status keys arrive as string[]. exact: true rejects undeclared keys
// (e.g. tracking=x) with HTTP 400.
export type TPaymentFilter = IObject<{
  limit?: number & Integer & Minimum<1>;
  status?: PaymentStatus | PaymentStatus[];
}, { exact: true }>;
// #endregion payment-filter

// #region payment-class
// Generated fields and conversion. Interceptor constructs this for class params.
export class Payment extends PaymentBaseModel {}
// #endregion payment-class
