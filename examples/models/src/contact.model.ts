import { parse } from '@exprtlabs/golem/serde';

// #region discriminated-union
import type { IModel } from '@exprtlabs/golem/model';

export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
// How to reach a task's assignee: by email or by phone.
export type TContact = IModel<{ value: TEmail | TPhone }>;
// #endregion discriminated-union

export function readContactKind(text: string): 'email' | 'phone' {
  return parse<TContact>(text).value.kind;
}
