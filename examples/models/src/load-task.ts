// #region validation-during-conversion
import { fromWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { TaskInput, type TTaskInput } from './task-input.model.js';

export async function loadInvalidTask() {
  const draft = new TaskInput(fromWireFormat<TTaskInput>({ title: '', done: false }, { validate: false }));
  const issues = await validateInstance(draft);
  console.log(issues[0]?.message); // 'Must be at least 1 character'
  console.log(draft.title); // '': trusted conversion does not validate

  return { message: issues[0]?.message, title: draft.title };
}
// #endregion validation-during-conversion
