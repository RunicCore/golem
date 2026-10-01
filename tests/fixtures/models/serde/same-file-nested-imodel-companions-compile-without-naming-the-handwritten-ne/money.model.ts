import type { IModel } from '@exprtlabs/golem/model';
import { CollectionBaseModel, ItemBaseModel } from './money.model.generated.js';
export type TItem = IModel<{ sku: string; quantity: number }>;
export type TCollection = IModel<{ id: string; items: TItem[] }>;
export class Item extends ItemBaseModel {}
export class Collection extends CollectionBaseModel {}