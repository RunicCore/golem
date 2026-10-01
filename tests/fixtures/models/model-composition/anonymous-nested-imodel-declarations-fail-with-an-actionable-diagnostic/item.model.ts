
import type { IModel } from '@exprtlabs/golem/model';
import { ItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<{ child: IModel<{ value: string }> }>;
export class Item extends ItemBaseModel {}
