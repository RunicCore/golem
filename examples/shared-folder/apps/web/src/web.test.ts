import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { Customer } from './customer.js';
import { readCustomer, writeCustomer } from './customers.js';

const customer = '{"name":"Ada","address":{"street":"1 Main St","city":"Leeds"},"balance":{"amount":"12.50","currency":"GBP"}}';

test('the web app reads the shared customer into its own class and writes it back', () => {
  const read = readCustomer(customer);
  assert.ok(read instanceof Customer);
  assert.equal(read.label(), 'Ada, Leeds');
  assert.equal(writeCustomer(read), customer);
});

test('the web app rejects an empty city, a rule on a plain type nested in the shared customer', () => {
  const emptyCity = customer.replace('"city":"Leeds"', '"city":""');
  assert.throws(() => readCustomer(emptyCity), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
});

test('the web app rejects a currency code that the shared isCurrencyCode rule refuses', () => {
  const lowerCase = customer.replace('"GBP"', '"gbp"');
  assert.throws(() => readCustomer(lowerCase), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
});
