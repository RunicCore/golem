import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Cart } from './build/src/cart.model.js';
import { ProfileClient } from './build/sdk/client.js';
import { findGeneratedModelDefinition, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';

// The script runs without the build rewrite, so it calls the codec the rewrite would bind.
const modelCodec = (model) => requireObjectCodec(findGeneratedModelDefinition(model).codecId);

const profile = JSON.parse(fs.readFileSync('./profile.json', 'utf8'));
const cart = modelCodec(Cart).fromWireFormat({ money: { amount: -1, currency: 'usd' }, note: 'draft' }, { construct: Cart, validate: false });
assert.deepEqual(cart.money, { amount: -1, currency: 'usd' });
assert.deepEqual(modelCodec(cart).toWireFormat(cart, { validate: false }), { money: { amount: -1, currency: 'usd' }, note: 'draft' });
assert.equal('$makeObservable' in cart, false);
assert.equal('$validator' in cart, false);

// The limits of the SDK reach the app model only in golem mode, which a profile with mobx uses: 'usd' breaks the pattern of the currency there.
const sdkLimitsApply = profile.mobx;
if (profile.validation) {
  const symbolsBefore = Object.getOwnPropertySymbols(cart);
  const issues = await validateInstance(cart, { failFast: false });
  assert.ok(Object.isFrozen(issues));
  assert.deepEqual(Object.getOwnPropertySymbols(cart), symbolsBefore);
  assert.equal(await getValidator(cart).validate({ failFast: false }), !sdkLimitsApply);
  assert.deepEqual(issues, getValidator(cart).issues);
  assert.equal(issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['money', 'currency'])), sdkLimitsApply);
} else {
  await assert.rejects(() => validateInstance(cart));
}

if (profile.mobx) {
  const { autorun, isObservableProp, runInAction } = await import('mobx');
  assert.equal(isObservableProp(cart, 'note'), true);
  assert.equal(isObservableProp(cart.money, 'amount'), true);
  const amounts = [];
  const dispose = autorun(() => amounts.push(cart.money.amount));
  runInAction(() => { cart.money.amount = 2; });
  runInAction(() => { cart.money = { amount: 3, currency: 'USD' }; });
  assert.equal(isObservableProp(cart.money, 'amount'), true);
  runInAction(() => { cart.money.amount = 4; });
  assert.deepEqual(amounts, [-1, 2, 3, 4]);
  dispose();
}

let calls = 0;
const client = new ProfileClient({
  baseUrl: 'https://example.invalid',
  fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ amount: -1, currency: 'usd' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
});
if (profile.validation) {
  await assert.rejects(() => client.getMoney().execute({}));
  await assert.rejects(() => client.createMoney().execute({ body: { amount: -1, currency: 'usd' } }));
  assert.equal(calls, 1);
} else {
  const response = await client.getMoney().execute({});
  assert.equal(response.body.amount, -1);
  await client.createMoney().execute({ body: { amount: -1, currency: 'usd' } });
  assert.equal(calls, 2);
}
const badStatus = new ProfileClient({
  baseUrl: 'https://example.invalid',
  fetchImpl: async () => new Response('{}', { status: 418, headers: { 'content-type': 'application/json' } }),
});
await assert.rejects(() => badStatus.getMoney().execute({}));
