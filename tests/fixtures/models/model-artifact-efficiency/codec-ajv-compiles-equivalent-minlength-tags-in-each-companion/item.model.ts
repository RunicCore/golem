import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { ItemBaseModel, type ItemFields } from './item.model.generated.js';
export type TItem = IModel<{ value: string & MinLength<2>; extra: string & MinLength<4> }>;
export class Item extends ItemBaseModel {
  constructor(values: Partial<ItemFields> = {}) { super(values); }
}
