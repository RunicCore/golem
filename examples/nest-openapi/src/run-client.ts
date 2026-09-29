import { PaymentsClient } from '../sdk/index.js';
import { submitPayment } from './client.js';
import type { TPaymentInput } from './payment.model.js';

const client = new PaymentsClient({ baseUrl: process.env.API_BASE_URL ?? 'http://127.0.0.1:3000' });
// TPaymentInput uses the JSON form: the amount is a decimal string.
const draft: TPaymentInput = {
  merchant: { id: 'merchant-1', name: 'Book shop' },
  billing: { name: 'Accounts' },
  money: { amount: '12.50', currency: 'USD' },
  note: 'Order 123',
};
const payment = await submitPayment(client, draft);
console.log(`Payment ${payment.id}: ${payment.money.currency} ${payment.money.amount}`);
