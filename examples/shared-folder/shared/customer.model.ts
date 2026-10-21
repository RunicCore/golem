import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import type { TAddress } from './address.js';
import type { TMoney } from './money.js';

// #region shared-model
// A shared folder declares the model and nothing else: no class and no generated file.
export type TCustomer = IModel<{
  name: string & MinLength<1>;
  address: TAddress;
  balance: TMoney;
}>;
// #endregion shared-model
