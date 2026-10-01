import 'temporal-polyfill/global';
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { PaymentModel, PaymentsClient } from '../sdk/index.js';

// #region read-dates
export async function readDueDate(client: PaymentsClient, id: string): Promise<Temporal.PlainDate> {
  const response = await client.getPayment().execute({ path: { id } });
  const payment = fromWireFormat<PaymentModel>(response.body);
  return payment.dueOn; // dueOn is `format: date`, so it is a Temporal.PlainDate
}
// #endregion read-dates

// #region write-dates
export function describePayment() {
  const payment = new PaymentModel({
    id: 'payment-1',
    amount: 25,
    currency: 'USD',
    createdAt: Temporal.Instant.from('2025-01-02T03:04:05Z'),
    dueOn: Temporal.PlainDate.from('2025-02-01'),
  });
  return toWireFormat<PaymentModel>(payment);
  // { ..., createdAt: '2025-01-02T03:04:05Z', dueOn: '2025-02-01' }
}
// #endregion write-dates
