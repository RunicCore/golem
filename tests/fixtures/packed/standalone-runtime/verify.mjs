import assert from 'node:assert/strict';
import { Cart } from './build/src/cart.model.js';
import { ProfileClient } from './build/sdk/client.js';
import { encodeGeneratedModel, decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { getValidator } from '@exprtlabs/golem/validation';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';

const wire = { money: { amount: 2, currency: 'USD' }, count: 2, when: '2026-01-01T00:00:00.000Z', code: 'ff' };
const model = decodeGeneratedModel(Cart, wire);
assert.ok(model.when instanceof Date);
assert.equal(model.code, 255);
assert.deepEqual(encodeGeneratedModel(model), wire);
model.count = 0;
assert.equal(await getValidator(model).validate(), false);
assert.ok(getValidator(model).error('count'));

const client = new ProfileClient({
  baseUrl: 'https://api.example.test',
  fetchImpl: async () => new Response(JSON.stringify({ amount: -1, currency: 'usd' }), {
    headers: { 'content-type': 'application/json' },
  }),
});
await assert.rejects(
  () => client.getMoney().execute({}),
  error => error instanceof LibError && error.kind === LibErrorKind.Validation,
);
