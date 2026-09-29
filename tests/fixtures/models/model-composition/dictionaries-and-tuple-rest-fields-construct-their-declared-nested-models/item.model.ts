
import type { IModel } from '@exprtlabs/codegen/model';
import { ItemBase, AddressBase } from './item.model.generated.js';
export type TAddress = IModel<{ city: string }>;
export type TItem = IModel<{
 dictionary: Record<string, TAddress>;
 tuple: [first: TAddress, ...rest: TAddress[]];
}>;
export class Address extends AddressBase {}
export class Item extends ItemBase {}
