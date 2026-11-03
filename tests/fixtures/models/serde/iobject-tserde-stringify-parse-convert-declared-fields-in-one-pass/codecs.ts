import type { Pattern } from '@exprtlabs/golem/tags';
export type PermissionWire = string & Pattern<'^0x[0-9a-fA-F]+$'>;
export function serializePermission(value: number): PermissionWire {
  return `0x${value.toString(16)}` as PermissionWire;
}
export let deserializeCalls = 0;
export function deserializePermission(value: PermissionWire): number {
  deserializeCalls += 1;
  return Number.parseInt(value, 16);
}
