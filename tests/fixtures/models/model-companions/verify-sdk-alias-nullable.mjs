import assert from 'node:assert/strict';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import './build/order.model.generated.js';
import { MoneyModel } from './build/sdk/models.js';

const codec = requireObjectCodec(process.argv[2]);
const full = codec.parse(JSON.stringify({ id: 'o1', money: { currency: 'VND', amount: 3 }, history: [{ currency: 'VND', amount: 1 }, null], kept: { currency: 'USD', amount: 2 } }));
assert.ok(full.money instanceof MoneyModel, 'a nullable SDK alias is the SDK class');
assert.ok(full.history[0] instanceof MoneyModel, 'an SDK alias in a nullable array item is the SDK class');
assert.equal(full.history[1], null);
assert.ok(full.kept instanceof MoneyModel, 'NonNullable of an SDK alias is the SDK class');
const empty = codec.parse(JSON.stringify({ id: 'o2', money: null, history: [], kept: { currency: 'USD', amount: 2 } }));
assert.equal(empty.money, null);
