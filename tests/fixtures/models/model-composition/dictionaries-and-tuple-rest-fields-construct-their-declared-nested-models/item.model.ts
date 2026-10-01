
import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel, TVenueBaseModel } from './item.model.generated.js';
export type TVenue = IModel<{ town: string }>;
export type TItem = IModel<{
 dictionary: Record<string, TVenue>;
 tuple: [first: TVenue, ...rest: TVenue[]];
}>;
export class Venue extends TVenueBaseModel {}
export class Item extends TItemBaseModel {}
