import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { ItemBase, type ItemFields } from './item.model.generated.js';
export type TItem = IModel<{ value: string & MinLength<2>; extra: string & MinLength<4> }>;
export class Item extends ItemBase {
  constructor(values: Partial<ItemFields> = {}) { super(values); }
}
