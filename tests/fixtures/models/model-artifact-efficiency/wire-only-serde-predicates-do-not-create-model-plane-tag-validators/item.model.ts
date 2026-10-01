import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { encode, decode } from './codecs.js';
import { TItemBaseModel, type TItemFields } from './item.model.generated.js';
export type TItem = IModel<{ value: number & TSerde<typeof encode, typeof decode> }>;
export class Item extends TItemBaseModel {
  constructor(values: Partial<TItemFields> = {}) { super(values); }
}
