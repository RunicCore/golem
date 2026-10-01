// #region task-model
import { TaskBaseModel } from './task.model.generated.js';
// #region task-declaration
import type { IModel } from '@exprtlabs/golem/model';

export type TTask = IModel<{
  title: string;
  done: boolean;
}>;
// #endregion task-declaration

export class Task extends TaskBaseModel {
  toggle(): void {
    this.done = !this.done;
  }
}
// #endregion task-model
