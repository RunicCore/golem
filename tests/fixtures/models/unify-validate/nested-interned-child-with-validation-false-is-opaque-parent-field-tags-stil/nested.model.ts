import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { notBlank } from './predicates.js';
import { TParentBaseModel, type TParentFields } from './nested.model.generated.js';
export type TChild = IObject<{ secret: string }, { validation: false }>;
export type TParent = IModel<{ child: TChild; note: string & TValidation<typeof notBlank> }>;
export class Parent extends TParentBaseModel { constructor(values: Partial<TParentFields> = {}) { super(values); } }