// #region money-model
import type { IObject } from '@exprtlabs/golem/model';
import type { Pattern } from '@exprtlabs/golem/tags';

// Amounts are decimal strings and currencies are ISO 4217 codes; no float carries money.
export type TMoney = IObject<{
  amount: string & Pattern<'^[0-9]+(?:\\.[0-9]{1,2})?$'>;
  currency: string & Pattern<'^[A-Z]{3}$'>;
}>;
// #endregion money-model

// Budget uses TMoney as a field. Without a model that nests TMoney somewhere,
// the generated file's helper functions for TMoney go unused and fail the build.
import type { IModel } from '@exprtlabs/golem/model';
import { TBudgetBaseModel } from './estimate.model.generated.js';

export type TBudget = IModel<{ estimate: TMoney }>;
export class Budget extends TBudgetBaseModel {}
