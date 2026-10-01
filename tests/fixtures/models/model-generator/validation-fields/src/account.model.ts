import type { IModel } from '@exprtlabs/golem/model';
import { TAccountBaseModel, type TAccountFields } from './account.model.generated.js';
import { getValidator } from '@exprtlabs/golem/validation';

export type TAccount = IModel<{ id: string; active: boolean }>;

export class Account extends TAccountBaseModel {
  constructor(values: Partial<TAccountFields> = {}) {
    super(values);
    getValidator(this).extend({ id: value => value.length > 0 });
  }
}
