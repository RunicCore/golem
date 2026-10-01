// #region decimal-price
import type { IModel } from '@exprtlabs/golem/model';
import type { Minimum, TSerde } from '@exprtlabs/golem/tags';
import type { readAmount, writeAmount } from './decimal-text.js';

export type TPrice = IModel<{
  amount: number & Minimum<0> & TSerde<typeof writeAmount, typeof readAmount>;
  currency: 'USD' | 'EUR';
}>;
// #endregion decimal-price

import { toWireFormat } from '@exprtlabs/golem/serde';
// Registers the generated codec; the type above has no class that imports it.
import './price.model.generated.js';

export function writePrice(money: { amount: number; currency: 'USD' | 'EUR' }) {
  return toWireFormat<TPrice>(money);
}
