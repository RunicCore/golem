import type { IModel } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';
import type { Money } from './sdk/types.js';
import { TWalletBaseModel, type TWalletFields, type TWalletInit, type TWalletJSON } from './wallet.model.generated.js';

export type TWallet = IModel<{
  money: Money | string;
  mixed: (Money | string | { kind: 'other'; value: number }) & Discriminator<'kind', Money>;
  values: [string, boolean, ...number[]];
}>;

export class Wallet extends TWalletBaseModel {}

export const tupleValues: [TWalletFields['values'], TWalletInit['values'], TWalletJSON['values']] = [
  ['x', true, 1, 2],
  ['x', true],
  ['x', true, 1],
];
