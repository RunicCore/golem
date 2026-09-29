
import type { IModel } from '@exprtlabs/codegen/model';
import { ItemBase } from './item.model.generated.js';
export type TItem = IModel<{
  readonly name: string;
  readonly nested: { readonly value: string };
}>;
export class Item extends ItemBase {}
