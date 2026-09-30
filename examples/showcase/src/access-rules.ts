// #region model-and-tags
import type { Integer, Maximum, MaxLength, MinLength, Pattern, TSerde, TValidation, Minimum } from '@exprtlabs/golem/tags';

export type ProjectName = string & MinLength<3> & MaxLength<48> & Pattern<'^[A-Za-z][A-Za-z0-9 -]*$'>;

export type PermissionBits = number
  & Integer
  & Minimum<0>
  & Maximum<255>
  & TValidation<typeof hasReadPermission>
  & TSerde<typeof serializePermissions, typeof deserializePermissions>;

export type PermissionWire = string & Pattern<'^0x[0-9a-fA-F]+$'>;

export const WRITE_PERMISSION = 0b0100;
const READ_PERMISSION = 0b0001;
const MAX_PERMISSION_BITS = 0xff;

export function hasReadPermission(value: number): boolean | string {
  return (value & READ_PERMISSION) !== 0
    ? true
    : 'A project access record must include the read permission bit.';
}

export function serializePermissions(value: number): PermissionWire {
  if (!Number.isInteger(value) || value < 0 || value > MAX_PERMISSION_BITS) {
    throw new RangeError('Permissions must be an integer between 0 and 255.');
  }
  return `0x${value.toString(16)}`;
}

export function deserializePermissions(value: PermissionWire): number {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new TypeError('Permissions must be a hexadecimal string.');
  }
  const decoded = Number.parseInt(value.slice(2), 16);
  if (!Number.isInteger(decoded) || decoded < 0 || decoded > MAX_PERMISSION_BITS) {
    throw new RangeError('Permissions must fit in one byte.');
  }
  return decoded;
}
// #endregion model-and-tags
