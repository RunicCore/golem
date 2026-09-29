
import type { IModel } from '@exprtlabs/codegen/model';
import { ItemBase } from './item.model.generated.js';
export type TItem = IModel<{ child: IModel<{ value: string }> }>;
export class Item extends ItemBase {}
