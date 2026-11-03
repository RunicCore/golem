import type { IModel } from '@exprtlabs/golem/model';
import { TObjectTypeFieldBaseModel, TObjectClassFieldBaseModel, TPoint3DBaseModel } from './money.model.generated.js';
export type TPoint3D = IModel<{ x: number; y: number; z: number }>;
export type TObjectTypeField = IModel<{ id: string; scale: TPoint3D }>;
export type TObjectClassField = IModel<{ id: string; scale: Point3D }>;
export class Point3D extends TPoint3DBaseModel {}
export class ObjectTypeField extends TObjectTypeFieldBaseModel {}
export class ObjectClassField extends TObjectClassFieldBaseModel {}