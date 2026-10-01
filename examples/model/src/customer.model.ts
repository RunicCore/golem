// #region nested-and-derived
import type { IModel } from '@exprtlabs/golem/model';
import { parse } from '@exprtlabs/golem/serde';
import { TAddressBaseModel, TCustomerBaseModel } from './customer.model.generated.js';

export type TAddress = IModel<{
  id: string;
  city: string;
  country: string;
}>;
export class Address extends TAddressBaseModel {}

export type TCustomer = IModel<{
  home: Address;
  shipping: Omit<TAddress, 'id'>;
  draft: Partial<Pick<TAddress, 'city' | 'country'>>;
}>;
export class Customer extends TCustomerBaseModel {}

export function loadCustomer(): Customer {
  const customer = parse<Customer>(JSON.stringify({
    home: { id: 'address-1', city: 'Hanoi', country: 'VN' },
    shipping: { city: 'Da Nang', country: 'VN' },
    draft: { city: 'Hue' },
  }));
  console.log(customer.home instanceof Address); // true
  console.log(Object.getPrototypeOf(customer.shipping) === Object.prototype); // true
  return customer;
}
// #endregion nested-and-derived
