import type { IObject, IModel } from '@exprtlabs/golem/model';
import type { Integer, Maximum, TSerde } from '@exprtlabs/golem/tags';
import type { serializePermission, deserializePermission } from './codecs.js';
import { PermissionBase } from './permission.model.generated.js';
export type TPermissionInput = IObject<{ permissions: number & Integer & Maximum<255> & TSerde<typeof serializePermission, typeof deserializePermission> }>;
export type TPermissionModel = IModel<{ permissions: number & Integer & Maximum<255> & TSerde<typeof serializePermission, typeof deserializePermission> }>;
export class Permission extends PermissionBase {}