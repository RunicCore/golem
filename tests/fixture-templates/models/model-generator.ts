import { identifier, tsSource, type SourceFragment } from '../../source-template.js';

export function accountModelWithField({ field }: { readonly field: 'done' | 'complete' }): SourceFragment {
  const fieldName = identifier(field);
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';
import { TAccountBaseModel, type TAccountFields } from './account.model.generated.js';
export type TAccount = IModel<{ id: string; ${fieldName}: boolean }>;
export class Account extends TAccountBaseModel {
  constructor(values: Partial<TAccountFields> = {}) { super(values); }
  public readsField(): boolean { return this.${fieldName}; }
}`;
}

export function accountModelWithMissingImport({ field }: { readonly field: 'done' | 'complete' }): SourceFragment {
  const model = accountModelWithField({ field });
  return tsSource`${model}
import { Missing } from './unrelated-missing-module.js';
export const missing = Missing;`;
}
