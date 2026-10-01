
import type { IModel } from '@exprtlabs/golem/model';
import { TItemBaseModel } from './item.model.generated.js';
export type TItem = IModel<{
  readonly name: string;
  readonly nested: { readonly value: string };
}>;
export class Item extends TItemBaseModel {}
