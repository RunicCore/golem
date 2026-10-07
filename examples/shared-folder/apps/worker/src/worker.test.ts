import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { readCustomer, readCustomerChecked, writeCustomer } from './customers.js';

const customer = '{"name":"Ada","address":{"street":"1 Main St","city":"Leeds"}}';
const emptyCity = '{"name":"Ada","address":{"street":"1 Main St","city":""}}';

test('the worker reads and writes the shared customer', () => {
  const read = readCustomer(customer);
  assert.deepEqual(read, { name: 'Ada', address: { street: '1 Main St', city: 'Leeds' } });
  assert.equal(writeCustomer(read), customer);
});

test('the worker accepts an empty city because its profile has validation off', () => {
  assert.deepEqual(readCustomer(emptyCity), { name: 'Ada', address: { street: '1 Main St', city: '' } });
});

test('the worker cannot ask for validation that its profile does not generate', () => {
  assert.throws(
    () => readCustomerChecked(emptyCity),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
});
