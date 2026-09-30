import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Cart } from './build/src/cart.model.js';
import { MoneyModel } from './build/sdk/index.js';
import { ProfileClient } from './build/sdk/client.js';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { getValidator, validateInstance } from '@exprtlabs/golem/validation';

const profile = JSON.parse(fs.readFileSync('./profile.json', 'utf8'));
const cart = decodeGeneratedModel(Cart, { money: { amount: -1, currency: 'usd' }, note: 'draft' });
assert.ok(cart.money instanceof MoneyModel);
assert.deepEqual(encodeGeneratedModel(cart), { money: { amount: -1, currency: 'usd' }, note: 'draft' });
assert.equal('$makeObservable' in cart, false);
assert.equal('$validator' in cart, false);

if (profile.validation) {
  const symbolsBefore = Object.getOwnPropertySymbols(cart);
  const issues = await validateInstance(cart, { failFast: false });
  assert.ok(Object.isFrozen(issues));
  assert.deepEqual(Object.getOwnPropertySymbols(cart), symbolsBefore);
  assert.equal(await getValidator(cart).validate({ failFast: false }), false);
  assert.deepEqual(issues, getValidator(cart).issues);
  assert.ok(issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['money', 'currency'])));
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
  const replacement = decodeGeneratedModel(MoneyModel, { amount: 3, currency: 'USD' });
  assert.equal(isObservableProp(replacement, 'amount'), true);
  runInAction(() => { cart.money = replacement; });
  runInAction(() => { replacement.amount = 4; });
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
