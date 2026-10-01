import type { IModel } from '@exprtlabs/golem/model';
import { ChildBaseModel, type ChildFields } from './child.model.generated.js';
export type TChild = IModel<{ name: string }, { exact: true }>;
export class Child extends ChildBaseModel {
  public readonly savingState = { dirty: true };
  constructor(values: Partial<ChildFields> = {}) { super(values); }
}
