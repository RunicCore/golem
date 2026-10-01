import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { encode, decode } from './codecs.js';
import { ItemBaseModel, type ItemFields } from './item.model.generated.js';
export type TItem = IModel<{ value: number & TSerde<typeof encode, typeof decode> }>;
export class Item extends ItemBaseModel {
  constructor(values: Partial<ItemFields> = {}) { super(values); }
}
