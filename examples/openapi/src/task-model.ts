// #region task-model
import { fromWireFormat } from '@exprtlabs/golem/serde';
import { TaskModel } from '../sdk/index.js';

export function loadTask(data: { id: string; title: string }): TaskModel {
  const task = fromWireFormat<TaskModel>(data);
  console.log(task instanceof TaskModel); // true
  return task;
}
// #endregion task-model
