import type { IModel } from '@exprtlabs/golem/model';
import { TParentBaseModel, type TParentFields } from './parent.model.generated.js';
import type { TChild } from './child.model.js';
export type TParent = IModel<{ id: number; child: TChild; children: TChild[] }>;
export class Parent extends TParentBaseModel {
  constructor(values: Partial<TParentFields> = {}) { super(values); }
}
