
import type { IModel } from '@exprtlabs/codegen/model';
export type TItem = IModel<{ id: string }>;
export type TParent = IModel<{ child: TItem }>;
export class Item { unrelated = true; }
