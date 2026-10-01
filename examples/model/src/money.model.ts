// #region money-model
import type { IObject } from '@exprtlabs/golem/model';
import type { Minimum } from '@exprtlabs/golem/tags';

export type TMoney = IObject<{
  amount: number & Minimum<0>;
  currency: 'USD' | 'EUR';
}>;
// #endregion money-model

// Wallet uses TMoney as a field. Without a model that nests TMoney somewhere,
// the generated file's helper functions for TMoney go unused and fail the build.
import type { IModel } from '@exprtlabs/golem/model';
import { WalletBaseModel } from './money.model.generated.js';

export type TWallet = IModel<{ balance: TMoney }>;
export class Wallet extends WalletBaseModel {}
