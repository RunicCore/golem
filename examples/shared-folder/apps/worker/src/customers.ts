import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TWorkerCustomer } from './customer.model.js';
import './customer.model.generated.js'; // registers the customer codec

export function readCustomer(text: string): TWorkerCustomer {
  return parse<TWorkerCustomer>(text);
}

export function readCustomerChecked(text: string): TWorkerCustomer {
  return parse<TWorkerCustomer>(text, { validate: true });
}

export function writeCustomer(customer: TWorkerCustomer): string {
  return stringify<TWorkerCustomer>(customer);
}
