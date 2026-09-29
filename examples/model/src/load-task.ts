// #region validation-during-conversion
import { fromWireFormat } from '@exprtlabs/codegen/serde';
import { validateInstance } from '@exprtlabs/codegen/validation';
import { TaskInput, type TTaskInput } from './task-input.model.js';

export async function loadInvalidTask() {
  const draft = new TaskInput(fromWireFormat<TTaskInput>({ title: '', done: false }, { validate: false }));
  const issues = await validateInstance(draft);
  console.log(issues[0]?.message); // 'must NOT have fewer than 1 characters'
  console.log(draft.title); // '': trusted conversion does not run Ajv

  return { message: issues[0]?.message, title: draft.title };
}
// #endregion validation-during-conversion
