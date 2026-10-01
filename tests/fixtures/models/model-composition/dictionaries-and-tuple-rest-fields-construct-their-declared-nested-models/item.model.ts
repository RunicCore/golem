
import type { IModel } from '@exprtlabs/golem/model';
import { ItemBaseModel, VenueBaseModel } from './item.model.generated.js';
export type TVenue = IModel<{ town: string }>;
export type TItem = IModel<{
 dictionary: Record<string, TVenue>;
 tuple: [first: TVenue, ...rest: TVenue[]];
}>;
export class Venue extends VenueBaseModel {}
export class Item extends ItemBaseModel {}
