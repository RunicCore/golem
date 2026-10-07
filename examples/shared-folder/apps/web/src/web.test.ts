import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { readOrder, writeOrder } from './orders.js';

const order = '{"customer":{"name":"Ada","address":{"street":"1 Main St","city":"Leeds"}},"total":{"amount":"12.50","currency":"GBP"},"lines":[{"sku":"tea","quantity":2}]}';

test('the web app reads and writes an order that nests the shared customer and money', () => {
  const read = readOrder(order);
  assert.deepEqual(read, {
    customer: { name: 'Ada', address: { street: '1 Main St', city: 'Leeds' } },
    total: { amount: '12.50', currency: 'GBP' },
    lines: [{ sku: 'tea', quantity: 2 }],
  });
  assert.equal(writeOrder(read), order);
});

test('the web app rejects an empty city, a rule on a plain type inside the shared customer', () => {
  const emptyCity = order.replace('"city":"Leeds"', '"city":""');
  assert.throws(() => readOrder(emptyCity), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
});

test('the web app rejects a currency code of the wrong length, a rule on the shared money', () => {
  const longCode = order.replace('"GBP"', '"GBPX"');
  assert.throws(() => readOrder(longCode), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
});
