// #region server-errors
import { TaskInput } from './task-input.model.js';
import { getValidator } from '@exprtlabs/codegen/validation';

export function checkServerErrors() {
  const task = new TaskInput({ title: 'Write release notes', done: false });
  const validator = getValidator(task);
  validator.setErrors({ title: 'This title is already used.' });
  const beforeClear = validator.error('title');
  console.log(beforeClear); // 'This title is already used.'

  validator.clear();
  const afterClear = validator.error('title');
  console.log(afterClear); // undefined

  return { beforeClear, afterClear };
}
// #endregion server-errors
