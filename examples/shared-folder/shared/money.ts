import type { TValidation } from '@exprtlabs/golem/tags';
import type { isCurrencyCode } from './rules.js';

// A plain type. Amounts are decimal strings and currencies are ISO 4217 codes; no float carries money.
export type TMoney = {
  amount: string;
  currency: string & TValidation<typeof isCurrencyCode>;
};
