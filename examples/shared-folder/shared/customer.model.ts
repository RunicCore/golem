import type { IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import type { TAddress } from './address.js';

export type TCustomer = IObject<{
  name: string & MinLength<1>;
  address: TAddress;
}>;
