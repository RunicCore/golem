import type { IModel } from '@exprtlabs/golem/model';
import { ObjectTypeFieldBaseModel, ObjectClassFieldBaseModel, Point3DBaseModel } from './money.model.generated.js';
export type TPoint3D = IModel<{ x: number; y: number; z: number }>;
export type TObjectTypeField = IModel<{ id: string; scale: TPoint3D }>;
export type TObjectClassField = IModel<{ id: string; scale: Point3D }>;
export class Point3D extends Point3DBaseModel {}
export class ObjectTypeField extends ObjectTypeFieldBaseModel {}
export class ObjectClassField extends ObjectClassFieldBaseModel {}