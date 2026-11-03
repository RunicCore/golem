
import type { IModel } from '@exprtlabs/golem/model';
export type TItem = IModel<{ id: string }>;
export type TParent = IModel<{ child: TItem }>;
export class Item { unrelated = true; }
