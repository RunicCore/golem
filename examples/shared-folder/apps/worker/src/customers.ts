// #region worker-use
import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TCustomer } from '../shared/customer.model.js';
import './generated/models/shared/customer.model.generated.js'; // registers the customer codec

// The worker uses the same shared model with its own profile: validation is off.
export function readCustomer(text: string): TCustomer {
  return parse<TCustomer>(text);
}
// #endregion worker-use

export function readCustomerChecked(text: string): TCustomer {
  return parse<TCustomer>(text, { validate: true });
}

export function writeCustomer(customer: TCustomer): string {
  return stringify<TCustomer>(customer);
}
