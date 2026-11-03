import { parse } from '@exprtlabs/golem/serde';

// #region discriminated-union
import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';

export type TEmail = IModel<{ kind: 'email'; address: string }>;
export type TPhone = IModel<{ kind: 'phone'; number: string }>;
// How to reach a task's assignee: by email or by phone. `kind` is the tag key.
export type TContact = IModel<{ value: (TEmail | TPhone) & Discriminator<'kind'> }>;
// #endregion discriminated-union

// #region union-tag-forms
// An alias names the tagged union once.
export type TContactValue = (TEmail | TPhone) & Discriminator<'kind'>;
export type TContactBook = IModel<{
  primary: TContactValue;
  // `null` stays outside the tag.
  backup: TContactValue | null;
  others: TContactValue[];
}>;
// #endregion union-tag-forms

// #region union-tag-default
export type TNote = IModel<{ text: string }>;
// A note has no `kind`, so it is the default. A value whose `kind` matches no other variant is a note.
export type TContactOrNote = IModel<{ value: (TEmail | TPhone | TNote) & Discriminator<'kind', TNote> }>;
// #endregion union-tag-default

export function readContactKind(text: string): 'email' | 'phone' {
  return parse<TContact>(text).value.kind;
}
