import { toWireFormat } from '@exprtlabs/golem/serde';
import { Task } from './task.model.js';
import type { TTask } from './task.model.js';
import type { TTaskJSON } from './task.model.generated.js';

export interface TaskDraft {
  title: string;
  done?: boolean;
}

export function createTask(draft: TaskDraft): Task {
  return new Task({
    title: draft.title,
    done: draft.done ?? false,
  });
}

export function saveTask(task: Task): TTaskJSON {
  return toWireFormat<TTask>(task);
}
