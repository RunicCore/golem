import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { MinLength, TValidation } from '@exprtlabs/golem/tags';
import { notBlank } from './rules.js';
import { TCheckedBaseModel, type TCheckedFields } from './mixed.model.generated.js';
export type TTrusted = IObject<{ id: string }, { validation: false }>;
export type TChecked = IModel<{ title: string & MinLength<3>; note?: string & TValidation<typeof notBlank> }, { validation: 'sanity' }>;
export type TOuter = IModel<{ inner: TChecked; code: string & MinLength<3> }>;
export class Checked extends TCheckedBaseModel { constructor(values: Partial<TCheckedFields> = {}) { super(values); } }
