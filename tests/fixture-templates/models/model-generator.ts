import { identifier, tsSource, type SourceFragment } from '../../source-template.js';

export function accountModelWithField({ field }: { readonly field: 'done' | 'complete' }): SourceFragment {
  const fieldName = identifier(field);
  return tsSource`import type { IModel } from '@exprtlabs/golem/model';
import { AccountBaseModel, type AccountFields } from './account.model.generated.js';
export type TAccount = IModel<{ id: string; ${fieldName}: boolean }>;
export class Account extends AccountBaseModel {
  constructor(values: Partial<AccountFields> = {}) { super(values); }
  public readsField(): boolean { return this.${fieldName}; }
}`;
}

export function accountModelWithMissingImport({ field }: { readonly field: 'done' | 'complete' }): SourceFragment {
  const model = accountModelWithField({ field });
  return tsSource`${model}
import { Missing } from './unrelated-missing-module.js';
export const missing = Missing;`;
}
