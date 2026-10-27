// #region serde-tag
import type { IModel } from '@exprtlabs/golem/model';
import type { PermissionBits } from './permission-rules.js';
import { fromWireFormat, toWireFormat } from '@exprtlabs/golem/serde';
import { validateInstance } from '@exprtlabs/golem/validation';
import { TPermissionInputBaseModel } from './permission-input.model.generated.js';

export type TPermissionInput = IModel<{
  permissions: PermissionBits;
}>;

export class PermissionInput extends TPermissionInputBaseModel {}

export async function checkPermissionInput() {
  const access = fromWireFormat<TPermissionInput>({ permissions: '0x5' });
  const wire = toWireFormat<TPermissionInput>(access);
  const issues = await validateInstance(new PermissionInput({ permissions: 2 }));

  // -> { permissions: 5, wire: { permissions: '0x5' }, deniedMessage: 'Read permission is required.' }
  return { permissions: access.permissions, wire, deniedMessage: issues[0]?.message };
}
// #endregion serde-tag
