// #region custom-rule
import type { IModel } from '@exprtlabs/golem/model';
import type { TaskTitle } from './task-input-rule.js';
import { TaskInputBase } from './task-input.model.generated.js';

export type TTaskInput = IModel<{
  title: TaskTitle;
  done: boolean;
}>;

export class TaskInput extends TaskInputBase {}
// #endregion custom-rule
