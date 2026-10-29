import assert from 'node:assert/strict';
import { Cart } from './build/src/cart.model.js';
import { ProfileClient } from './build/sdk/client.js';
import { findGeneratedModelDefinition, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator } from '@exprtlabs/golem/validation';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';

// The script runs without the build rewrite, so it calls the codec the rewrite would bind.
const modelCodec = (model) => requireObjectCodec(findGeneratedModelDefinition(model).codecId);

const wire = { money: { amount: 2, currency: 'USD' }, count: 2, when: '2026-01-01T00:00:00.000Z', code: 'ff' };
const model = modelCodec(Cart).fromWireFormat(wire, { construct: Cart });
assert.ok(model.when instanceof Date);
assert.equal(model.code, 255);
assert.deepEqual(modelCodec(model).toWireFormat(model), wire);
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
