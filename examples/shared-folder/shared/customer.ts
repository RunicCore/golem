import type { MinLength } from '@exprtlabs/golem/tags';
import type { TAddress } from './address.js';

// A plain type that nests another plain type.
export type TCustomer = {
  name: string & MinLength<1>;
  address: TAddress;
};
