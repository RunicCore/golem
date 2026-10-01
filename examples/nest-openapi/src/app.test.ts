import assert from 'node:assert/strict';
import test from 'node:test';
import { fromWireFormat } from '@exprtlabs/golem/serde';
import { writePrice, type TPrice } from './price.model.js';
import { createApplication } from './application.js';
import { registerApplicationTests } from './app-workflows.js';

registerApplicationTests(createApplication);

test('TSerde stores a number in the model and writes a decimal string in JSON', () => {
  assert.deepEqual(writePrice({ amount: 12.5, currency: 'USD' }), { amount: '12.50', currency: 'USD' });
  assert.deepEqual(fromWireFormat<TPrice>({ amount: '12.50', currency: 'USD' }), { amount: 12.5, currency: 'USD' });
});
