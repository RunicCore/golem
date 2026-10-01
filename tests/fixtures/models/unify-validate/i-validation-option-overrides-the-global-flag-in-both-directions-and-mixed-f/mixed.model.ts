import type { IModel, IObject } from '@exprtlabs/golem/model';
import { CheckedBaseModel, type CheckedFields } from './mixed.model.generated.js';
export type TTrusted = IObject<{ id: string }, { validation: false }>;
export type TChecked = IModel<{ title: string }, { validation: true }>;
export class Checked extends CheckedBaseModel { constructor(values: Partial<CheckedFields> = {}) { super(values); } }