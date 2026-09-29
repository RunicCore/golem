// #region serde-tag-fn
import type { Integer, Maximum, Minimum, Pattern, TSerde, TValidation } from '@exprtlabs/codegen/tags';

export function hasReadPermission(value: number): boolean | string {
  return (value & 1) !== 0 ? true : 'Read permission is required.';
}

export type PermissionWire = string & Pattern<'^0x[0-9a-fA-F]+$'>;

export function encodePermissions(value: number): PermissionWire {
  return `0x${value.toString(16)}`;
}

export function decodePermissions(value: PermissionWire): number {
  // This guard also runs when generated validation is disabled.
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new TypeError('Permissions must be hexadecimal.');
  return Number.parseInt(value.slice(2), 16);
}

export type PermissionBits = number
  & Integer
  & Minimum<0>
  & Maximum<255>
  & TValidation<typeof hasReadPermission>
  & TSerde<typeof encodePermissions, typeof decodePermissions>;
// #endregion serde-tag-fn
