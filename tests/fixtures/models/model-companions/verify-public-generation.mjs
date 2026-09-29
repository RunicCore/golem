import assert from 'node:assert/strict';
import { Wallet } from './build/wallet.model.js';
import { MoneyModel } from './build/sdk/models.js';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { getValidator } from '@exprtlabs/codegen/validation';

const wallet = decodeGeneratedModel(Wallet, {
  money: { currency: 'VND', amount: 3 },
  mixed: 'cash',
  values: ['x', 1, 2, true],
});
assert.ok(wallet.money instanceof MoneyModel);
assert.deepEqual(encodeGeneratedModel(wallet), {
  money: { currency: 'VND', amount: 3 },
  mixed: 'cash',
  values: ['x', 1, 2, true],
});
assert.equal(await getValidator(wallet).validate(), true);

const invalid = decodeGeneratedModel(Wallet, {
  money: 'cash',
  mixed: 'cash',
  values: ['x', 1, 'bad', true],
});
assert.equal(await getValidator(invalid).validate(), false);
assert.ok(getValidator(invalid).issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['values', 2])));
