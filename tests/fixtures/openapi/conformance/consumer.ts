import { PaymentModel } from './models.js';
import { decodeGeneratedModel } from '@exprtlabs/codegen/conversion';
export class ObservablePayment extends PaymentModel {
  settle(): number { this.id = 'settled'; return this.amount; }
}
export const parsedPayment: PaymentModel = decodeGeneratedModel(PaymentModel, { amount: 1, id: 'pay_1' });
export const parsedObservable: ObservablePayment = decodeGeneratedModel(ObservablePayment, { amount: 1, id: 'pay_2' });
