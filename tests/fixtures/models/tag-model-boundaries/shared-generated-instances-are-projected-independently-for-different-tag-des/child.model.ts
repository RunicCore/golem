import type { IModel } from '@exprtlabs/golem/model';
import { TSharedChildBaseModel, type TSharedChildFields } from './child.model.generated.js';
export type TSharedChild = IModel<{ value: string; extra: number }>;
export class SharedChild extends TSharedChildBaseModel {
  constructor(values: Partial<TSharedChildFields> = {}) { super(values); }
}