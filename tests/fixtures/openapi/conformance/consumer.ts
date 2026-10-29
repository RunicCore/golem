import { PaymentModel } from './index.js';
import { fromWireFormat } from '@exprtlabs/golem/serde';
export class ObservablePayment extends PaymentModel {
  settle(): number { this.id = 'settled'; return this.amount; }
}
export const parsedPayment: PaymentModel = fromWireFormat<PaymentModel>({ amount: 1, id: 'pay_1' });
export const parsedObservable: ObservablePayment = fromWireFormat<ObservablePayment>({ amount: 1, id: 'pay_2' });
