import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/types.js';
import { WalletBaseModel, type WalletFields, type WalletInit, type WalletJSON } from './wallet.model.generated.js';

export type TWallet = IModel<{
  money: Money | string;
  mixed: Money | string | { kind: 'other'; value: number };
  values: [string, ...number[], boolean];
}>;

export class Wallet extends WalletBaseModel {}

export const tupleValues: [WalletFields['values'], WalletInit['values'], WalletJSON['values']] = [
  ['x', 1, 2, true],
  ['x', true],
  ['x', 1, true],
];
