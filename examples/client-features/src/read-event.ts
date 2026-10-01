// #region read-event
import { parse } from '@exprtlabs/golem/serde';
import { PaymentCaptured } from './event-models/payment-events.model.js';

export function readCaptured(text: string): PaymentCaptured {
  return parse<PaymentCaptured>(text); // a PaymentCaptured instance from the generated declaration
}
// #endregion read-event
