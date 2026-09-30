import type { IModel } from '@exprtlabs/golem/model';
import { CollectionBase, ItemBase } from './money.model.generated.js';
export type TItem = IModel<{ sku: string; quantity: number }>;
export type TCollection = IModel<{ id: string; items: TItem[] }>;
export class Item extends ItemBase {}
export class Collection extends CollectionBase {}