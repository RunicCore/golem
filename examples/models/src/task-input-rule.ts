// #region custom-rule-fn
import type { MinLength, TValidation } from '@exprtlabs/golem/tags';

export function notBlank(value: string): boolean | string {
  return value.trim().length > 0 || 'Enter a title.';
}

export type TaskTitle = string & MinLength<1> & TValidation<typeof notBlank>;
// #endregion custom-rule-fn
