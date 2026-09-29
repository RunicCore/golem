import { toWireFormat } from '@exprtlabs/codegen/serde';
import { validateInstance } from '@exprtlabs/codegen/validation';
import { type PaymentsClientPort, type Money } from '../sdk/index.js';
import { PaymentEditor } from './payment-editor.model.js';
import type { TPaymentEditor } from './payment-editor.model.js';
import type { PaymentEditorJSON } from './payment-editor.model.generated.js';

export interface PaymentDraft {
  money: Money;
  note: string;
}

export function createPaymentEditor(draft: PaymentDraft): PaymentEditor {
  return new PaymentEditor(draft);
}

// #region validate-and-save
export async function savePayment(client: PaymentsClientPort, editor: PaymentEditor) {
  if ((await validateInstance(editor)).length > 0) {
    throw new Error('Cannot save an invalid payment.');
  }
  const wire: PaymentEditorJSON = toWireFormat<TPaymentEditor>(editor);
  return client.createPayment().execute({ body: wire.money });
}
// #endregion validate-and-save
