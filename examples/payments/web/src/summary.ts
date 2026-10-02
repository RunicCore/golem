import { fromWireFormat } from '@exprtlabs/golem/serde';
import { autorun } from 'mobx';
import { PaymentEditor } from './payment-editor.model.js';

// #region observe-payment
export function observeSummary(editor: PaymentEditor, report: (summary: string) => void): () => void {
  return autorun(() => report(editor.summary)); // Runs again when the amount, currency or note changes.
}
// #endregion observe-payment

// #region payment-example
export function examplePayment(): PaymentEditor {
  const editor = new PaymentEditor();
  editor.setAmount('12.50');
  editor.setNote('Order 123');
  return editor;
}
// #endregion payment-example

// #region load-from-wire
export function loadPaymentEditor(wire: unknown): PaymentEditor {
  return fromWireFormat<PaymentEditor>(wire); // Builds the editor and its nested money model.
}
// #endregion load-from-wire
