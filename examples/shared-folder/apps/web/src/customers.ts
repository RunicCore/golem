import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TCustomer } from '../../../shared/customer.model.js';
import { Customer } from './customer.js';

export function readCustomer(text: string): Customer {
  return parse<Customer>(text);
}

export function writeCustomer(customer: Customer): string {
  return stringify<TCustomer>(customer);
}
