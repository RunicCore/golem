// #region payment-client
import { fromWireFormat } from '@exprtlabs/golem/serde';
import { PaymentModel, type PaymentsClient, type TPaymentInputJSON } from '../sdk/index.js';

export async function submitPayment(client: PaymentsClient, draft: TPaymentInputJSON): Promise<PaymentModel> {
  // #region create-payment
  const response = await client.createPayment().execute({ body: draft });
  // #endregion create-payment
  // The client returns plain JSON; fromWireFormat<PaymentModel> builds the model from it.
  return fromWireFormat<PaymentModel>(response.body);
}
// #endregion payment-client
