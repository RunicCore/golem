import assert from 'node:assert/strict';
import { Wallet } from './build/wallet.model.js';
import { MoneyModel } from './build/sdk/models.js';
import { findGeneratedModelDefinition, requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator } from '@exprtlabs/golem/validation';

// The script runs without the build rewrite, so it calls the codec the rewrite would bind.
const modelCodec = (model) => requireObjectCodec(findGeneratedModelDefinition(model).codecId);
const wallet = modelCodec(Wallet).fromWireFormat({
  money: { currency: 'VND', amount: 3 },
  mixed: 'cash',
  values: ['x', true, 1, 2],
}, { construct: Wallet });
assert.ok(wallet.money instanceof MoneyModel);
// toWireFormat copies a nested SDK model and keeps its class, so the comparison is on the JSON text.
assert.deepEqual(JSON.parse(JSON.stringify(modelCodec(wallet).toWireFormat(wallet))), {
  money: { currency: 'VND', amount: 3 },
  mixed: 'cash',
  values: ['x', true, 1, 2],
});
assert.equal(await getValidator(wallet).validate(), true);

const invalid = modelCodec(Wallet).fromWireFormat({
  money: 'cash',
  mixed: 'cash',
  values: ['x', true, 1, 'bad'],
}, { construct: Wallet, validate: false });
assert.equal(await getValidator(invalid).validate(), false);
assert.ok(getValidator(invalid).issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(['values', 3])));
