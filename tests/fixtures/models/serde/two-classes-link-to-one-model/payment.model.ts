import type { IModel } from '@exprtlabs/golem/model';
import { TPaymentBaseModel, TLedgerBaseModel } from './payment.model.generated.js';

export type TPayment = IModel<{ id: string; amount: number }>;
export class Payment extends TPaymentBaseModel {}
export class AdminPayment extends TPaymentBaseModel {
  get admin(): boolean { return true; }
}
export class RushPayment extends AdminPayment {}

export type TLedger = IModel<{ first: Payment; second: AdminPayment; third: TPayment }>;
export class Ledger extends TLedgerBaseModel {}
