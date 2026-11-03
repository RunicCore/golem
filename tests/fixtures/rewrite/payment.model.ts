import { TPaymentBaseModel } from './payment.model.generated.js';

export type TMoney = { currency: string; value: string };
export type TPayment = { id: string; amount: TMoney };
export type TUnkeyed = { id: string };
export class Payment extends TPaymentBaseModel {}
