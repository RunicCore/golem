// #region discriminated-union
import type { IModel } from '@exprtlabs/golem/model';
import { TEmailBaseModel, TPhoneBaseModel } from './contact.model.generated.js';

export type TEmail = IModel<{ kind: 'email'; address: string }>;
export class Email extends TEmailBaseModel {}
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
export class Phone extends TPhoneBaseModel {}
export type TContact = IModel<{ value: TEmail | TPhone }>;
// #endregion discriminated-union

import { parse } from '@exprtlabs/golem/serde';

export function readContactKind(text: string): 'email' | 'phone' {
  return parse<TContact>(text).value.kind;
}
