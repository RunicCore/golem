import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { TItemBaseModel, type TItemFields } from './item.model.generated.js';
export type TItem = IModel<{ value: string & MinLength<2>; extra: string & MinLength<4> }>;
export class Item extends TItemBaseModel {
  constructor(values: Partial<TItemFields> = {}) { super(values); }
}
