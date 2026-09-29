// #region collection-tags
import type { IModel } from '@exprtlabs/codegen/model';
import type {
  Contains,
  Format,
  MinContains,
  DependentRequired,
} from '@exprtlabs/codegen/tags';
import { validateInstance } from '@exprtlabs/codegen/validation';
import { ContractsBase } from './collection-tags.model.generated.js';

type Email = string & Format<'email'>;
type Destinations = string[] & Contains<Email> & MinContains<1>;

type BillingDetails = {
  card?: string;
  billingAddress?: string;
} & DependentRequired<{ card: ['billingAddress'] }>;

export type TContracts = IModel<{
  destinations: Destinations;
  billing: BillingDetails;
}>;
export class Contracts extends ContractsBase {}

export async function checkContracts(): Promise<[boolean, boolean]> {
  const accepted = {
    destinations: ['mina@example.com'],
    billing: { card: '4242424242424242', billingAddress: '1 Main St' },
  };
  const rejected = {
    destinations: ['mina@example.com'],
    billing: { card: '4242424242424242' },
  };
  return [
    (await validateInstance(new Contracts(accepted))).length === 0, // true
    (await validateInstance(new Contracts(rejected))).length === 0, // false: billingAddress is missing
  ];
}
// #endregion collection-tags
