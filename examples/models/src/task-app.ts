import { toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { Task } from './task.model.js';
import type { TTask } from './task.model.js';
import type { TTaskJSON } from './task.model.generated.js';

export function createTask(draft: { title: string; done?: boolean; priority?: number }): Task {
  return new Task({ title: draft.title, done: draft.done ?? false, priority: draft.priority ?? 2 });
}

export async function toValidTaskJSON(task: Task): Promise<TTaskJSON> {
  if ((await validateInstance(task)).length > 0) {
    throw new Error('Cannot write an invalid task.');
  }
  return toWireFormat<TTask>(task);
}
