// #region payment-draft
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { PaymentDraftBase } from './payment-draft.model.generated.js';

export type TPaymentDraft = IModel<{ note: string & MinLength<2> }>;
export class PaymentDraft extends PaymentDraftBase {}
// #endregion payment-draft
