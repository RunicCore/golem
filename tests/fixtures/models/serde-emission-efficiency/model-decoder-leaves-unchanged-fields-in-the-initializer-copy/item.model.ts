import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { ItemBaseModel, type ItemFields } from './item.model.generated.js';
import { decodeCode, encodeCode } from './codecs.js';
export type TItem = IModel<{ title: string; code: string & TSerde<typeof encodeCode, typeof decodeCode> }>;
export class Item extends ItemBaseModel {
  constructor(values: Partial<ItemFields> = {}) { super(values); }
}