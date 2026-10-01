import type { IModel } from '@exprtlabs/golem/model';
import { ChildBaseModel, type ChildFields } from './child.model.generated.js';
export type TChild = IModel<{ name: string }>;
export class Child extends ChildBaseModel {
  public static constructed = 0;
  constructor(values: Partial<ChildFields> = {}) {
    super({ name: "default", ...values });
    Child.constructed += 1;
  }
}