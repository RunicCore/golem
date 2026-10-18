import type { WireFormat } from '@exprtlabs/golem/serde';
import type { Assert, NotAny, Same } from './wire-assert.js';
import type { Address, Customer, Node, TAddress, TCustomer, TNode } from './customer.model.js';
import type { TAddressJSON, TCustomerJSON, TNodeJSON } from './customer.model.generated.js';

export type AddressSame = Assert<Same<WireFormat<TAddress>, TAddressJSON>>;
export type AddressClassSame = Assert<Same<WireFormat<Address>, TAddressJSON>>;
export type CustomerSame = Assert<Same<WireFormat<TCustomer>, TCustomerJSON>>;
export type CustomerClassSame = Assert<Same<WireFormat<Customer>, TCustomerJSON>>;
export type NodeSame = Assert<Same<WireFormat<TNode>, TNodeJSON>>;
export type NodeClassSame = Assert<Same<WireFormat<Node>, TNodeJSON>>;
export type CustomerNotAny = Assert<NotAny<WireFormat<TCustomer>>>;
