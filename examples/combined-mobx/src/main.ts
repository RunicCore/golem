import { autorun } from 'mobx';
import { PaymentsClient } from '../sdk/index.js';
import { createPaymentEditor, savePayment } from './payment-app.js';

const editor = createPaymentEditor({
  money: { amount: 25, currency: 'USD' },
  note: 'Lunch',
});
const stopSummary = autorun(() => { console.info('combined-mobx:', editor.summary); });
editor.setAmount(30);

// #region validate-and-save
const baseUrl = process.env.PAYMENTS_API_BASE_URL;
try {
  if (!baseUrl) {
    console.info('combined-mobx: set PAYMENTS_API_BASE_URL to your Payments API to save this payment.');
  } else {
    const response = await savePayment(new PaymentsClient({ baseUrl }), editor);
    console.info('combined-mobx: payment saved', response.body);
  }
} finally {
  stopSummary();
}
// #endregion validate-and-save
