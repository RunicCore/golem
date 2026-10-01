import type { IModel } from '@exprtlabs/golem/model';
import { ItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<{ count: number }>;
export class Item extends ItemBaseModel {}