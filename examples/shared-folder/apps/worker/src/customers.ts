import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TCustomer } from '../shared/customer.model.js';
import '../shared/customer.model.generated.js'; // registers the customer codec

export function readCustomer(text: string): TCustomer {
  return parse<TCustomer>(text);
}

export function readCustomerChecked(text: string): TCustomer {
  return parse<TCustomer>(text, { validate: true });
}

export function writeCustomer(customer: TCustomer): string {
  return stringify<TCustomer>(customer);
}
