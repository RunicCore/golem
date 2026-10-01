
import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel as Base } from '#generated/item';
export type TItem = IModel<{ id: string }>;
export class Item extends Base { get label() { return this.id; } }
