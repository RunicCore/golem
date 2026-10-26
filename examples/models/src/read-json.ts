// #region read-json
import { parse, stringify } from '@exprtlabs/golem/serde';
import { Task } from './task.model.js';
import type { TTask } from './task.model.js';

export function readTask(text: string): Task {
  return parse<Task>(text); // a Task instance with toggle()
}

export function readTaskData(text: string): TTask {
  return parse<TTask>(text); // a plain object with the same fields
}

// #endregion read-json

// #region write-task
export function writeTask(task: Task): string {
  return stringify<TTask>(task); // '{"title":"…","done":false,"priority":"normal"}'
}
// #endregion write-task
