import { getValidator } from '@exprtlabs/golem/validation';
import { Account } from './account.model.js';

class AccountEditor extends Account {
  public readonly localOnly = true;
}

const editor = new AccountEditor({ id: 'account-1', active: true });
getValidator(editor).extend({ id: value => value.length > 0, active: value => value });
getValidator(editor).setErrors({ id: 'already exists' });
getValidator(editor).extend({
  // @ts-expect-error handwritten subclass state is not a generated model field
  localOnly: value => value,
});
getValidator(editor).setErrors({
  // @ts-expect-error handwritten subclass state is not a generated model field
  localOnly: 'must be rejected',
});
