import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { MinLength, TSerde } from '@exprtlabs/golem/tags';
import type { fromCents, toCents } from './codecs.js';
import { TMerchantBaseModel, TPaymentBaseModel } from './payment.model.generated.js';

export type TMoney = IObject<{ amount: number & TSerde<typeof toCents, typeof fromCents>; currency: 'EUR' | 'USD' }>;
export type TMerchant = IModel<{ id: string; name: string & MinLength<2> }>;
// A named alias chooses the derived name (Billing); the unnamed Omit field gets MerchantOmitId.
type TBilling = Omit<TMerchant, 'id'>;
export type TPayment = IModel<{ id: string; merchant: TMerchant; billing: TBilling; shipping: Omit<TMerchant, 'id' | 'name'>; money: TMoney }>;

export class Merchant extends TMerchantBaseModel {}
export class Payment extends TPaymentBaseModel {}
