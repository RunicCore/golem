import type { IModel } from '@exprtlabs/golem/model';
import { IsolatedPointBaseModel, ObjectClassFieldBaseModel } from './money.model.generated.js';
export type TIsolatedPoint = IModel<{ x: number; y: number; z: number }>;
export type TObjectClassField = IModel<{ id: string; scale: IsolatedPoint }>;
export class IsolatedPoint extends IsolatedPointBaseModel {}
export class ObjectClassField extends ObjectClassFieldBaseModel {}