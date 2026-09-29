import type { IModel } from '@exprtlabs/codegen/model';
import { AccountBase, type AccountFields } from './account.model.generated.js';
import { getValidator } from '@exprtlabs/codegen/validation';

export type TAccount = IModel<{ id: string; active: boolean }>;

export class Account extends AccountBase {
  constructor(values: Partial<AccountFields> = {}) {
    super(values);
    getValidator(this).extend({ id: value => value.length > 0 });
  }
}
