// #region payment-client
import type { Payment, PaymentsClient, TPaymentInput } from '../sdk/index.js';

export async function submitPayment(client: PaymentsClient, draft: TPaymentInput): Promise<Payment | undefined> {
  // #region create-payment
  const response = await client.createPayment().execute({ body: draft });
  // #endregion create-payment
  // The client checks the body and returns a plain Payment; no conversion call is needed.
  return response.status === 201 ? response.body : undefined;
}
// #endregion payment-client
