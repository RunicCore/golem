import type { IModel } from '@exprtlabs/golem/model';
import { TChildBaseModel, type TChildFields } from './child.model.generated.js';
export type TChild = IModel<{ name: string }, { exact: true }>;
export class Child extends TChildBaseModel {
  constructor(values: Partial<TChildFields> = {}) { super(values); }
}
Object.defineProperty(Child.prototype, "savingState", { value: { dirty: true } });