import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<{ count: number }>;
export class Item extends TItemBaseModel {}