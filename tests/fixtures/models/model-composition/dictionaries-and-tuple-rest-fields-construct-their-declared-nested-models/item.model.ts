
import type { IModel } from '@exprtlabs/codegen/model';
import { ItemBase, VenueBase } from './item.model.generated.js';
export type TVenue = IModel<{ town: string }>;
export type TItem = IModel<{
 dictionary: Record<string, TVenue>;
 tuple: [first: TVenue, ...rest: TVenue[]];
}>;
export class Venue extends VenueBase {}
export class Item extends ItemBase {}
