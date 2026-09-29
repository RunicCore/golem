import type { IModel } from '@exprtlabs/codegen/model';
import { ChildBase, type ChildFields } from './child.model.generated.js';
export type TChild = IModel<{ name: string }>;
export class Child extends ChildBase {
  public static constructed = 0;
  constructor(values: Partial<ChildFields> = {}) {
    super({ name: "default", ...values });
    Child.constructed += 1;
  }
}