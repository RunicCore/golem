// #region model-definition
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength, TSerde } from '@exprtlabs/golem/tags';
import type { fromPriorityWord, toPriorityWord } from './priority-word.js';
import { TTaskBaseModel } from './task.model.generated.js';

export type TTask = IModel<{
  title: string & MinLength<1>;
  done: boolean;
  // Your code sorts by a number; the JSON carries a word.
  priority: number & TSerde<typeof toPriorityWord, typeof fromPriorityWord>;
}>;

export class Task extends TTaskBaseModel {
  public toggle(): void {
    this.done = !this.done;
  }
}
// #endregion model-definition
