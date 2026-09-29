import type { IModel } from '@exprtlabs/codegen/model';
import { ChildBase, type ChildFields } from './child.model.generated.js';
export type TChild = IModel<{ value: string; extra: number }>;
export class Child extends ChildBase {
  constructor(values: Partial<ChildFields> = {}) { super(values); }
}