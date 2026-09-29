// #region nested-editing
import { autorun } from 'mobx';
import { PaymentEditor } from './payment-editor.model.js';

export function editPayment(report: (summary: string) => void = console.log): PaymentEditor {
  const editor = new PaymentEditor({
    money: { amount: 25, currency: 'USD' }, note: 'Lunch',
  });
  const stop = autorun(() => report(editor.summary)); // autorun logs: 25 USD: Lunch
  try {
    editor.setAmount(30); // autorun logs: 30 USD: Lunch
  } finally {
    stop();
  }
  return editor;
}
// #endregion nested-editing
