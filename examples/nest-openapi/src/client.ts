// #region payment-client
import { fromWireFormat } from '@exprtlabs/codegen/serde';
import { PaymentsClient } from '../sdk/client.js';
import { Payment, type TPaymentInput } from './payment.model.js';

export async function submitPayment(client: PaymentsClient, draft: TPaymentInput): Promise<Payment> {
  const response = await client.createPayment().execute({ body: draft });
  // The client returns plain JSON; fromWireFormat<Payment> builds your class from it.
  return fromWireFormat<Payment>(response.body);
}
// #endregion payment-client
