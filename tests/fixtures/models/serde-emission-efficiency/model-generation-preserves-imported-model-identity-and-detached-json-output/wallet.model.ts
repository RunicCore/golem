import type { IModel } from '@exprtlabs/codegen/model';
import type { Money } from './sdk/types.js';
import { WalletBase, type WalletFields } from './wallet.model.generated.js';
export type TWallet = IModel<{ money: Money }>;
export class Wallet extends WalletBase {
  constructor(values: Partial<WalletFields> = {}) { super(values); }
}