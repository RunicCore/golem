// #region payment-example
import { toWireFormat } from '@exprtlabs/codegen/serde';
import { PaymentEditor } from './payment-editor.model.js';
import type { TPaymentEditor } from './payment-editor.model.js';

export function editPayment(report: (summary: string) => void = console.log) {
  const editor = new PaymentEditor({ money: { amount: 30, currency: 'USD' }, note: 'Lunch' });
  const data = toWireFormat<TPaymentEditor>(editor);
  report(editor.summary); // prints 30 USD: Lunch
  return { editor, data };
}
// #endregion payment-example

import { fromWireFormat } from '@exprtlabs/codegen/serde';
import { validateInstance } from '@exprtlabs/codegen/validation';

export async function validateAndCorrectPayment() {
  // #region load-from-wire
  const editor = new PaymentEditor(fromWireFormat<TPaymentEditor>(
    {
      money: { amount: 25, currency: 'USD' },
      note: 'Lunch',
    },
  ));
  // #endregion load-from-wire

  editor.money.amount = -1;
  const initialIssues = await validateInstance(editor, { failFast: false });
  const initiallyValid = initialIssues.length === 0;
  const amountErrors = initialIssues.filter(issue => issue.path.join('/') === 'money/amount');
  editor.setAmount(30);
  const valid = (await validateInstance(editor)).length === 0;

  return {
    editor,
    initiallyValid,
    amountErrors,
    valid,
    data: toWireFormat<TPaymentEditor>(editor),
  };
}
