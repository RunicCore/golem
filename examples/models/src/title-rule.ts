// #region instance-rules
import { TaskInput } from './task-input.model.js';
import { getValidator } from '@exprtlabs/golem/validation';

export async function checkTitleRule() {
  const task = new TaskInput({ title: 'Write release notes', done: false });
  const validator = getValidator(task);
  validator.extend({
    title: value => value.startsWith('Ship') || 'Start the title with Ship.',
  });

  const valid = await validator.validate();

  // -> { valid: false, message: 'Start the title with Ship.' }
  return { valid, message: validator.error('title') };
}
// #endregion instance-rules
