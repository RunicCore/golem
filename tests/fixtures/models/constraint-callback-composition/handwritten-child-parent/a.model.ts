import type { IModel } from '@exprtlabs/golem/model';
import { ParentBaseModel, type ParentFields } from './parent.model.generated.js';
import type { Contains, TValidation } from '@exprtlabs/golem/tags';
import type { TChild } from './child.model.js';
import { childPredicate } from './predicates-2.js';

export type TParent = IModel<{
  children?: unknown[] & Contains<TChild & TValidation<typeof childPredicate>>;
}>;

export class Parent extends ParentBaseModel {
  constructor(values: Partial<ParentFields> = {}) { super(values); }
}
