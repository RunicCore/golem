import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TPaymentBaseModel } from './payment.model.generated.js';

export type TMerchant = IObject<{ id: string; name: string }>;
export type TMoney = IObject<{ amount: string; currency: string }>;
export type TCharge = IObject<{ id: string; status: 'pending' | 'captured'; settlesOn: string }>;
export type TPayment = IModel<{
  id: string;
  merchant: TMerchant;
  billing: Omit<TMerchant, 'id'>;
  money: TMoney;
  note: string;
  charge?: TCharge;
}, { exact: true }>;
export class Payment extends TPaymentBaseModel {}
