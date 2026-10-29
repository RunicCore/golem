import type { IModel, IObject } from '@exprtlabs/golem/model';
import { TCheckedBaseModel, type TCheckedFields } from './mixed.model.generated.js';
export type TTrusted = IObject<{ id: string }, { validation: false }>;
export type TChecked = IModel<{ title: string }, { validation: 'sanity' }>;
export class Checked extends TCheckedBaseModel { constructor(values: Partial<TCheckedFields> = {}) { super(values); } }