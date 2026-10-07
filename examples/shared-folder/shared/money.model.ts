import type { IObject } from '@exprtlabs/golem/model';
import type { MaxLength, MinLength } from '@exprtlabs/golem/tags';

// Amounts are decimal strings and currencies are ISO 4217 codes; no float carries money.
export type TMoney = IObject<{
  amount: string;
  currency: string & MinLength<3> & MaxLength<3>;
}>;
