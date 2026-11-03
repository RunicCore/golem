
import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<
  { id: string; count: number } &
  { nested: { enabled: boolean } }
>;
export class Item extends TItemBaseModel {}
