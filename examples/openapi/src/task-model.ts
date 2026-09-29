import { fromWireFormat } from '@exprtlabs/codegen/serde';
import { TaskModel } from '../sdk/index.js';

// #region task-model
export function loadTask(data: { id: string; title: string }): TaskModel {
  const task = fromWireFormat<TaskModel>(data);
  console.log(task instanceof TaskModel); // true
  return task;
}
// #endregion task-model
