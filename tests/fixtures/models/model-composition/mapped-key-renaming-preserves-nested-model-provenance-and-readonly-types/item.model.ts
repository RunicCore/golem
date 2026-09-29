
import type { IModel } from '@exprtlabs/codegen/model';
import { AddressBase, ContactBase, ItemBase } from './item.model.generated.js';
export type TAddress = IModel<{ city: string }>;
export type TContact = IModel<{ home: TAddress }>;
type Renamed<T> = { readonly [K in keyof T as `copy_${string & K}`]: T[K] };
type Writable<T> = { -readonly [K in keyof T]: T[K] };
export type TItem = IModel<{ contact: Renamed<TContact>; writable?: Writable<{ readonly code: string }> }>;
export class Address extends AddressBase {}
export class Contact extends ContactBase {}
export class Item extends ItemBase {}
