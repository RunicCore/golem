// #region builtin-tags
import type { IModel } from '@exprtlabs/codegen/model';
import type { MaxLength, MinLength } from '@exprtlabs/codegen/tags';
import { validateInstance } from '@exprtlabs/codegen/validation';
import { TaggedTaskBase } from './builtin-tags.model.generated.js';

type TaskTitle = string & MinLength<3> & MaxLength<80>;

export type TTaggedTask = IModel<{
  title: TaskTitle;
  done: boolean;
}>;

export class TaggedTask extends TaggedTaskBase {}

export async function validateTaskTitles(): Promise<[boolean, boolean, boolean]> {
  const short = new TaggedTask({ title: 'x', done: false });
  const longEnough = new TaggedTask({ title: 'release', done: false });
  const tooLong = new TaggedTask({ title: 'x'.repeat(81), done: false });
  return [
    (await validateInstance(short)).length === 0,
    (await validateInstance(longEnough)).length === 0,
    (await validateInstance(tooLong)).length === 0,
  ];
  // [false, true, false]
}
// #endregion builtin-tags
