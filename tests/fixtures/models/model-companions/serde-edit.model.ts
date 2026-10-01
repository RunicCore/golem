import type { IModel } from '@exprtlabs/golem/model';
import {
  fromWireFormat,
  parse,
  type SerdeOptions,
} from '@exprtlabs/golem/serde';
import { ItemBaseModel, type ItemFields } from "./item.model.generated.js";

export type TItem = IModel<{ title: string; value: number }>;
export const café = "prélude";
function optionsFor(value: unknown): SerdeOptions {
  return { validate: value !== undefined };
}
export class Item extends ItemBaseModel {
  constructor(values: Partial<ItemFields> = {}) { super(values); }

  parseItem(text: string): Item {
    return parse<Item>(text, optionsFor(parse<TItem>(text)));
  }
  fromWireItem(value: unknown): Item {
    return fromWireFormat<Item>(value, { validate: false });
  }
}
