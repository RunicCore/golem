import type { IModel } from '@exprtlabs/golem/model';
import type { TChild } from './child.model.js';
import { TParentBaseModel, type TParentFields } from './parent.model.generated.js';
type Box<T> = { value: T };
export type TParent = IModel<{ child: Box<TChild> }>;
export class Parent extends TParentBaseModel {
  constructor(values: Partial<TParentFields> = {}) { super(values); }
}