import { getValidator } from '@exprtlabs/codegen/validation';
import { UserModel } from './models.js';
class UserEditor extends UserModel {
  public readonly localOnly = true;
}
const editor = new UserEditor({ id: 'user-1', active: true });
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