import type { TValidation } from '@exprtlabs/golem/tags';
import type { isCurrencyCode } from './rules.js';

// A plain type. Amounts are decimal strings, so no float carries money. A currency is three capital letters.
export type TMoney = {
  amount: string;
  currency: string & TValidation<typeof isCurrencyCode>;
};
