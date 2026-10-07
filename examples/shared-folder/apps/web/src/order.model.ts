import type { IObject } from '@exprtlabs/golem/model';
import type { Minimum } from '@exprtlabs/golem/tags';
import type { TCustomer } from '../../../shared/customer.js';
import type { TMoney } from '../../../shared/money.js';

// #region app-model
// A plain type for one line of the order.
type TOrderLine = {
  sku: string;
  quantity: number & Minimum<1>;
};

// The app declares the IObject at the top level. The shared plain types nest inside it.
export type TOrder = IObject<{
  customer: TCustomer;
  total: TMoney;
  lines: TOrderLine[];
}>;
// #endregion app-model
