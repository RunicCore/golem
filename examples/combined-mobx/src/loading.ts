import { autorun } from 'mobx';
import { PaymentsClient } from '../sdk/index.js';

// #region loading
export function observeCreatePayment(client: PaymentsClient) {
  const createPayment = client.createPayment();
  const states: boolean[] = [];
  const stop = autorun(() => {
    states.push(createPayment.loading);
    console.log('Loading:', createPayment.loading);
    // Logs false initially, true during execute, then false after it settles.
  });
  return { createPayment, states, stop };
}
// #endregion loading
