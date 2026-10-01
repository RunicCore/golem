// #region money-model
import type { IObject } from '@exprtlabs/golem/model';
import type { Integer, Minimum } from '@exprtlabs/golem/tags';

// Money is an integer count of minor units (cents), never a float.
export type TMoney = IObject<{
  minorUnits: number & Integer & Minimum<0>;
  currency: 'USD' | 'EUR';
}>;
// #endregion money-model

// Budget uses TMoney as a field. Without a model that nests TMoney somewhere,
// the generated file's helper functions for TMoney go unused and fail the build.
import type { IModel } from '@exprtlabs/golem/model';
import { TBudgetBaseModel } from './estimate.model.generated.js';

export type TBudget = IModel<{ estimate: TMoney }>;
export class Budget extends TBudgetBaseModel {}
