import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/types.js';
import { WalletBaseModel } from './wallet.model.generated.js';
export type TWallet = IModel<{ money: Money | string; tagged: Money | { kind: 'other'; value: number } }>;
export class Wallet extends WalletBaseModel {}
