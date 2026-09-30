import type { IObject, IModel } from '@exprtlabs/golem/model';
import type { Integer, Maximum, Pattern, TSerde } from '@exprtlabs/golem/tags';
import { PermissionBase } from './permission.model.generated.js';
export type PermissionWire = string & Pattern<'^0x[0-9a-fA-F]+$'>;
export function serializePermission(value: number): PermissionWire {
  return `0x${value.toString(16)}` as PermissionWire;
}
export let deserializeCalls = 0;
export function deserializePermission(value: PermissionWire): number {
  deserializeCalls += 1;
  return Number.parseInt(value, 16);
}
export type TPermissionInput = IObject<{ permissions: number & Integer & Maximum<255> & TSerde<typeof serializePermission, typeof deserializePermission> }>;
export type TPermissionModel = IModel<{ permissions: number & Integer & Maximum<255> & TSerde<typeof serializePermission, typeof deserializePermission> }>;
export class Permission extends PermissionBase {}