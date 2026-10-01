// #region create-payment
import { PaymentsClient } from '../sdk/index.js';

const client = new PaymentsClient({ baseUrl: 'https://api.example.com' });
const response = await client.createPayment().execute({
  body: { amount: 25, currency: 'USD' },
});
// Request body: {"amount":25,"currency":"USD"}
// Content-Type: application/json
export const createdPayment = response.body; // Already decoded.
// #endregion create-payment
