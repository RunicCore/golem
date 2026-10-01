import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/types.js';
import { WalletBaseModel, type WalletFields } from './wallet.model.generated.js';
export type TWallet = IModel<{ money: Money }>;
export class Wallet extends WalletBaseModel {
  constructor(values: Partial<WalletFields> = {}) { super(values); }
}