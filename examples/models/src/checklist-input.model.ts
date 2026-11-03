// #region nested-field-errors
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';
import { TChecklistInputBaseModel } from './checklist-input.model.generated.js';

export type TChecklistInput = IModel<{
  items: Array<{ label: string & MinLength<3> }>;
}>;
export class ChecklistInput extends TChecklistInputBaseModel {}

export async function checkChecklistInput() {
  const checklist = new ChecklistInput({ items: [{ label: 'x' }] });
  const issues = await validateInstance(checklist);

  const validator = getValidator(checklist);
  await validator.validate();
  const labelError = validator.error(['items', 0, 'label']);

  checklist.items = [{ label: 'Tag' }];
  const fixedCount = (await validateInstance(checklist)).length;

  // -> { firstIssuePath: ['items', 0, 'label'], labelError: 'Must be at least 3 characters', fixedCount: 0 }
  return { firstIssuePath: issues[0]?.path, labelError, fixedCount };
}
// #endregion nested-field-errors
