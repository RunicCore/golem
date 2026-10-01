// #region tag-aliases
import type { IModel } from '@exprtlabs/golem/model';
import type { MaxLength, Pattern } from '@exprtlabs/golem/tags';
import { validateInstance } from '@exprtlabs/golem/validation';
import { AccountBaseModel } from './tag-aliases.model.generated.js';

type Varchar<N extends number> = string & MaxLength<N>;
type Handle<N extends number> = Varchar<N> & Pattern<'^[a-z0-9_]+$'>;

export type TAccount = IModel<{
  displayName: Varchar<80>;
  handle: Handle<20>;
}>;

export class Account extends AccountBaseModel {}

export async function validateHandles(): Promise<[boolean, boolean]> {
  const valid = new Account({ displayName: 'Ada', handle: 'ada_l' });
  const tooLong = new Account({ displayName: 'Ada', handle: 'a'.repeat(21) });
  return [(await validateInstance(valid)).length === 0, (await validateInstance(tooLong)).length === 0];
  // [true, false]
}
// #endregion tag-aliases
