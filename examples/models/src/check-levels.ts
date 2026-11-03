// #region validation-levels
import { parse } from '@exprtlabs/golem/serde';
import { validate } from '@exprtlabs/golem/validation';
import { TaskInput } from './task-input.model.js';

export function readTaskShape(text: string) {
  // The shape only: a blank title passes. A missing key or a wrong type throws.
  return parse<TaskInput>(text, { validate: 'sanity' });
}

export function hasTaskShape(value: unknown) {
  return validate<TaskInput>(value, { validate: 'sanity' });
}
// #endregion validation-levels
