import type { IModel } from '@exprtlabs/golem/model';
import { ChildBaseModel, type ChildFields } from './child.model.generated.js';
export type TChild = IModel<{ name: string }, { exact: true }>;
export class Child extends ChildBaseModel {
  constructor(values: Partial<ChildFields> = {}) { super(values); }
}
Object.defineProperty(Child.prototype, "savingState", { value: { dirty: true } });