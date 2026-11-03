// #region serde-tag-fn
import type { Integer, Maximum, Minimum, Pattern, TSerde, TValidation } from '@exprtlabs/golem/tags';

// A project member's access bits: 1 reads, 2 writes, 4 administers.
export function hasReadPermission(value: number): boolean | string {
  return (value & 1) !== 0 ? true : 'Read permission is required.';
}

export type PermissionWire = string & Pattern<'^0x[0-9a-fA-F]+$'>;

// TSerde functions live in their own module: generated files import them, and a model file cannot be imported back.
export function encodePermissions(value: number): PermissionWire {
  return `0x${value.toString(16)}`;
}

export function decodePermissions(value: PermissionWire): number {
  return Number.parseInt(value.slice(2), 16);
}

export type PermissionBits = number
  & Integer
  & Minimum<0>
  & Maximum<255>
  & TValidation<typeof hasReadPermission>
  & TSerde<typeof encodePermissions, typeof decodePermissions>;
// #endregion serde-tag-fn
