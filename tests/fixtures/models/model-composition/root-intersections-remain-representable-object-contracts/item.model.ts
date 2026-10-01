
import type { IModel } from '@exprtlabs/golem/model';
import { ItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<
  { id: string; count: number } &
  { nested: { enabled: boolean } }
>;
export class Item extends ItemBaseModel {}
