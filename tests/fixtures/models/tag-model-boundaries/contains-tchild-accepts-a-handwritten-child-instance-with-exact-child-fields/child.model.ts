import type { IModel } from '@exprtlabs/codegen/model';
import { ChildBase, type ChildFields } from './child.model.generated.js';
export type TChild = IModel<{ name: string }, { exact: true }>;
export class Child extends ChildBase {
  constructor(values: Partial<ChildFields> = {}) { super(values); }
}
Object.defineProperty(Child.prototype, "savingState", { value: { dirty: true } });