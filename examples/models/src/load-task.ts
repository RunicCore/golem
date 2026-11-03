// #region validation-during-conversion
import { fromWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { TaskInput } from './task-input.model.js';

export async function loadInvalidTask() {
  const draft = fromWireFormat<TaskInput>({ title: '', done: false }, { validate: false });
  const issues = await validateInstance(draft);

  // -> { message: 'Must be at least 1 character', title: '' }: the trusted conversion did not validate
  return { message: issues[0]?.message, title: draft.title };
}
// #endregion validation-during-conversion
