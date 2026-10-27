// #region validate-a-model
import { validateInstance } from '@exprtlabs/golem/validation';
import { TaskInput } from './task-input.model.js';

export async function checkTaskInput() {
  const task = new TaskInput({ title: ' ', done: false });
  const blank = await validateInstance(task);

  task.title = 'Write release notes';
  const fixed = await validateInstance(task);

  // -> { blank: ['Enter a title.'], fixed: true }
  return { blank: blank.map(issue => issue.message), fixed: fixed.length === 0 };
}
// #endregion validate-a-model
