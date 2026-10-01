import type { IModel } from '@exprtlabs/golem/model';
import { TChildBaseModel, type TChildFields } from './child.model.generated.js';
export type TChild = IModel<{ name: string }>;
export class Child extends TChildBaseModel {
  public static constructed = 0;
  constructor(values: Partial<TChildFields> = {}) {
    super({ name: "default", ...values });
    Child.constructed += 1;
  }
}