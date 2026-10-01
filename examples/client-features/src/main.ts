import { PaymentsClient } from '../sdk/index.js';
import { readDueDate } from './payment-dates.js';

const baseUrl = process.env.PAYMENTS_API_BASE_URL;
if (!baseUrl) {
  console.info('client-features: set PAYMENTS_API_BASE_URL to your Payments API to run the HTTP example.');
} else {
  console.info('client-features: payment-1 is due', String(await readDueDate(new PaymentsClient({ baseUrl }), 'payment-1')));
}
