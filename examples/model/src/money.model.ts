// #region money-model
import type { IObject } from '@exprtlabs/codegen/model';
import type { Minimum } from '@exprtlabs/codegen/tags';

export type TMoney = IObject<{
  amount: number & Minimum<0>;
  currency: 'USD' | 'EUR';
}>;
// #endregion money-model

// Wallet uses TMoney as a field. Without a model that nests TMoney somewhere,
// the generated file's helper functions for TMoney go unused and fail the build.
import type { IModel } from '@exprtlabs/codegen/model';
import { WalletBase } from './money.model.generated.js';

export type TWallet = IModel<{ balance: TMoney }>;
export class Wallet extends WalletBase {}
