import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import { TAddressBaseModel, TCustomerBaseModel, TNodeBaseModel } from './customer.model.generated.js';

export type TAddress = IModel<{ id: string; city: string & MinLength<2>; country?: string }>;
export type TEmail = IObject<{ kind: 'email'; address: string }>;
export type TPhone = IObject<{ kind: 'phone'; number: string }>;
type Contact = TEmail | TPhone;

export type TCustomer = IModel<{
  address: TAddress;
  omitted: Omit<TAddress, 'id'>;
  projected: Partial<Pick<TAddress, 'city' | 'country'>>;
  readonlyAddress: Readonly<TAddress>;
  inline: { street: string; since: Date };
  previous: TAddress[];
  contact: Contact;
  selected: Extract<Contact, { kind: 'email' }>;
}>;
export type TNode = IModel<{ label: string; children: TNode[] }>;

export class Address extends TAddressBaseModel {}
export class Customer extends TCustomerBaseModel {}
export class Node extends TNodeBaseModel {}
