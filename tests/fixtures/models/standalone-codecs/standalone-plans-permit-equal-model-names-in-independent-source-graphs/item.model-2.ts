import type { IModel } from '@exprtlabs/golem/model';
import { ItemBase } from './item.model.generated.js';
export type TItem = IModel<{ count: number }>;
export class Item extends ItemBase {}