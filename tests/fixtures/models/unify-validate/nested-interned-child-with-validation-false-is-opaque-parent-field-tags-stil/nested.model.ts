import type { IModel, IObject } from '@exprtlabs/codegen/model';
import type { TValidation } from '@exprtlabs/codegen/tags';
import { notBlank } from './predicates.js';
import { ParentBase, type ParentFields } from './nested.model.generated.js';
export type TChild = IObject<{ secret: string }, { validation: false }>;
export type TParent = IModel<{ child: TChild; note: string & TValidation<typeof notBlank> }>;
export class Parent extends ParentBase { constructor(values: Partial<ParentFields> = {}) { super(values); } }