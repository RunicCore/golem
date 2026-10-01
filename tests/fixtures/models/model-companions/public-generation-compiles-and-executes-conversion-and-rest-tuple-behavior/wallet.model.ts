import type { IModel } from '@exprtlabs/golem/model';
import type { Money } from './sdk/types.js';
import { TWalletBaseModel, type TWalletFields, type TWalletInit, type TWalletJSON } from './wallet.model.generated.js';

export type TWallet = IModel<{
  money: Money | string;
  mixed: Money | string | { kind: 'other'; value: number };
  values: [string, ...number[], boolean];
}>;

export class Wallet extends TWalletBaseModel {}

export const tupleValues: [TWalletFields['values'], TWalletInit['values'], TWalletJSON['values']] = [
  ['x', 1, 2, true],
  ['x', true],
  ['x', 1, true],
];
