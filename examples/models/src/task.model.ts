// #region model-definition
import { TTaskBaseModel } from './task.model.generated.js';
// #region task-declaration
import type { IModel } from '@exprtlabs/golem/model';
import type { Integer, Maximum, MinLength, Minimum, TSerde } from '@exprtlabs/golem/tags';
import type { fromPriorityWord, toPriorityWord } from './priority-word.js';

export type TTask = IModel<{
  title: string & MinLength<1>;
  done: boolean;
  // Your code sorts by a number from 1 to 3; the JSON carries a word.
  priority: number & Integer & Minimum<1> & Maximum<3> & TSerde<typeof toPriorityWord, typeof fromPriorityWord>;
}>;
// #endregion task-declaration

// #region task-class
export class Task extends TTaskBaseModel {
  public toggle(): void {
    this.done = !this.done;
  }
}
// #endregion task-class
// #endregion model-definition
