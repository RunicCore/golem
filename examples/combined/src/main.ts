import { createPaymentEditor, sendPayment } from './payment-app.js';

const baseUrl = process.env.PAYMENTS_API_BASE_URL;
if (!baseUrl) {
  console.info('combined: set PAYMENTS_API_BASE_URL to your Payments API to run the HTTP example.');
} else {
  const editor = createPaymentEditor({
    money: { amount: 25, currency: 'USD' },
    note: 'Lunch',
  });
  const response = await sendPayment(baseUrl, editor);
  console.info('combined: payment saved', response.body);
}
