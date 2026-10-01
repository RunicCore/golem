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
  console.log(issues[0]?.path); // ['items', 0, 'label']

  const validator = getValidator(checklist);
  await validator.validate();
  const labelError = validator.error(['items', 0, 'label']);
  console.log(labelError); // 'must NOT have fewer than 3 characters'

  checklist.items = [{ label: 'Tag' }];
  const fixedCount = (await validateInstance(checklist)).length;
  console.log(fixedCount); // 0

  return { firstIssuePath: issues[0]?.path, labelError, fixedCount };
}
// #endregion nested-field-errors
