import { toWireFormat } from '@exprtlabs/codegen/serde';
import { validateInstance } from '@exprtlabs/codegen/validation';
import { Task } from './task.model.js';
import type { TTask } from './task.model.js';
import type { TaskJSON } from './task.model.generated.js';

export function createTask(draft: { title: string; done?: boolean; priority?: number }): Task {
  return new Task({ title: draft.title, done: draft.done ?? false, priority: draft.priority ?? 2 });
}

export async function saveTask(task: Task): Promise<TaskJSON> {
  if ((await validateInstance(task)).length > 0) {
    throw new Error('Cannot save an invalid task.');
  }
  return toWireFormat<TTask>(task); // { title: 'Ship the generators', done: true, priority: 'normal' }
}
