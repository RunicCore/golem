import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/types.js';
import { TWalletBaseModel, type TWalletFields } from './wallet.model.generated.js';
export type TWallet = IModel<{ money: Money }>;
export class Wallet extends TWalletBaseModel {
  constructor(values: Partial<TWalletFields> = {}) { super(values); }
}