import type { IModel } from '@exprtlabs/golem/model';
import { IsolatedPointBase, ObjectClassFieldBase } from './money.model.generated.js';
export type TIsolatedPoint = IModel<{ x: number; y: number; z: number }>;
export type TObjectClassField = IModel<{ id: string; scale: IsolatedPoint }>;
export class IsolatedPoint extends IsolatedPointBase {}
export class ObjectClassField extends ObjectClassFieldBase {}