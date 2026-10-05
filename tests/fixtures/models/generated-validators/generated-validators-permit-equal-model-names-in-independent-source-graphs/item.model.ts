import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<{ label: string }>;
export class Item extends TItemBaseModel {}