// #region current-token
import { PaymentsClient } from '../sdk/index.js';

let accessToken = 'first-token';
const client = new PaymentsClient({
  baseUrl: 'https://api.example.com',
  auth: { bearerAuth: () => accessToken },
});
const createPayment = client.createPayment(); // No token lookup or request yet.

await createPayment.execute({ body: { amount: 25, currency: 'USD' } });
// Authorization: Bearer first-token

accessToken = 'refreshed-token';
await createPayment.execute({ body: { amount: 30, currency: 'EUR' } });
// Authorization: Bearer refreshed-token — the same operation reads the new value.
// #endregion current-token
