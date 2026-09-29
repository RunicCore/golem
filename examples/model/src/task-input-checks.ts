// #region validate-a-model
import { validateInstance } from '@exprtlabs/codegen/validation';
import { TaskInput } from './task-input.model.js';

export async function checkTaskInput() {
  const task = new TaskInput({ title: ' ', done: false });
  const issues = await validateInstance(task);
  console.log(issues.length); // 1
  console.log(issues[0]?.message); // 'Enter a title.'

  task.title = 'Write release notes';
  const fixed = (await validateInstance(task)).length === 0;
  console.log(fixed); // true

  return { issueCount: issues.length, message: issues[0]?.message, fixed };
}
// #endregion validate-a-model
