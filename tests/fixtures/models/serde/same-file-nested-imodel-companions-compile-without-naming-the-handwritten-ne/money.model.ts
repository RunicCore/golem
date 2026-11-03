import type { IModel } from '@exprtlabs/golem/model';
import { TCollectionBaseModel, TItemBaseModel } from './money.model.generated.js';
export type TItem = IModel<{ sku: string; quantity: number }>;
export type TCollection = IModel<{ id: string; items: TItem[] }>;
export class Item extends TItemBaseModel {}
export class Collection extends TCollectionBaseModel {}