// #region serde-tag
import type { IModel } from '@exprtlabs/golem/model';
import type { PermissionBits } from './permission-rules.js';
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { PermissionInputBaseModel } from './permission-input.model.generated.js';

export type TPermissionInput = IModel<{
  permissions: PermissionBits;
}>;

export class PermissionInput extends PermissionInputBaseModel {}

export async function checkPermissionInput() {
  const access = fromWireFormat<TPermissionInput>({ permissions: '0x5' });
  console.log(access.permissions); // 5: JSON pattern, numeric validation constraints and read rule passed
  console.log(toWireFormat<TPermissionInput>(access)); // { permissions: '0x5' }

  const denied = fromWireFormat<TPermissionInput>({ permissions: '0x2' }, { validate: false });
  console.log(denied.permissions); // 2: trusted conversion does not run Ajv
  const deniedValid = (await validateInstance(new PermissionInput(denied))).length === 0;
  console.log(deniedValid); // false: hasReadPermission rejects the model value
  console.log(toWireFormat<TPermissionInput>(denied, { validate: false })); // { permissions: '0x2' }

  return {
    accessPermissions: access.permissions,
    accessWire: toWireFormat<TPermissionInput>(access),
    deniedPermissions: denied.permissions,
    deniedValid,
    deniedWire: toWireFormat<TPermissionInput>(denied, { validate: false }),
  };
}
// #endregion serde-tag
