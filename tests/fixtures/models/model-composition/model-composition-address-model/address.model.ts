
import type { IModel } from '@exprtlabs/codegen/model';
import type { MinLength } from '@exprtlabs/codegen/tags';
import { AddressBase, CustomerBase } from './address.model.generated.js';
export type TAddress = IModel<{ id: string; city: string & MinLength<2>; country?: string }>;
type Identity<T> = T;
export type TCustomer = IModel<{
  address: Omit<TAddress, 'id'>;
  delivery: Partial<Pick<TAddress, 'city' | 'country'>>;
  intact: Identity<TAddress>;
  readonlyAddress: Readonly<TAddress>;
}>;
export class Address extends AddressBase { label() { return this.city; } }
export class Customer extends CustomerBase {}
