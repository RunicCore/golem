
import type { IModel } from '@exprtlabs/codegen/model';
import { ItemBase } from './item.model.generated.js';
export type TItem = IModel<
  { id: string; count: number } &
  { nested: { enabled: boolean } }
>;
export class Item extends ItemBase {}
