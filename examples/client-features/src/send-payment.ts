// #region send-payment
import { PaymentsClient } from '../sdk/index.js';

const client = new PaymentsClient({
  baseUrl: 'https://api.example.com', // Your API address.
  auth: { bearerAuth: 'access-token' }, // Keyed by security scheme name.
});

await client.createPayment().execute({
  body: { amount: 25, currency: 'USD' },
});
// The request includes: Authorization: Bearer access-token
// #endregion send-payment
