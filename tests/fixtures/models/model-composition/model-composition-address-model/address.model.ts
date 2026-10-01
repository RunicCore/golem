
import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { AddressBaseModel, CustomerBaseModel } from './address.model.generated.js';
export type TAddress = IModel<{ id: string; city: string & MinLength<2>; country?: string }>;
type Identity<T> = T;
export type TCustomer = IModel<{
  address: Omit<TAddress, 'id'>;
  delivery: Partial<Pick<TAddress, 'city' | 'country'>>;
  intact: Identity<TAddress>;
  readonlyAddress: Readonly<TAddress>;
}>;
export class Address extends AddressBaseModel { label() { return this.city; } }
export class Customer extends CustomerBaseModel {}
