import type { IModel } from '@exprtlabs/golem/model';
import type { TChild } from './child.model.js';
import { ParentBase, type ParentFields } from './parent.model.generated.js';
type Box<T> = { value: T };
export type TParent = IModel<{ child: Box<TChild> }>;
export class Parent extends ParentBase {
  constructor(values: Partial<ParentFields> = {}) { super(values); }
}