import assert from 'node:assert/strict';
import { Wallet } from './build/wallet.model.js';
import { MoneyModel } from './build/sdk/models.js';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { getValidator } from '@exprtlabs/golem/validation';

const wallet = decodeGeneratedModel(Wallet, {
  money: { currency: 'VND', amount: 3 },
  mixed: 'cash',
  values: ['x', true, 1, 2],
});
assert.ok(wallet.money instanceof MoneyModel);
// toWireFormat copies a nested SDK model and keeps its class, so the comparison is on the JSON text.
assert.deepEqual(JSON.parse(JSON.stringify(encodeGeneratedModel(wallet))), {
  money: { currency: 'VND', amount: 3 },
  mixed: 'cash',
  values: ['x', true, 1, 2],
});
assert.equal(await getValidator(wallet).validate(), true);

const invalid = decodeGeneratedModel(Wallet, {
  money: 'cash',
  mixed: 'cash',
  values: ['x', true, 1, 'bad'],
});
assert.equal(await getValidator(invalid).validate(), false);
assert.ok(getValidator(invalid).issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['values', 3])));
