import assert from 'node:assert/strict';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import './build/order.model.generated.js';
import { MoneyModel } from './build/sdk/models.js';

const codec = requireObjectCodec(process.argv[2]);
const text = JSON.stringify({ id: 'o1', money: { currency: 'VND', amount: 3 } });
const order = codec.parse(text);
assert.ok(order.money instanceof MoneyModel, 'the nested SDK model is the SDK class');
assert.equal(order.money.amount, 3);
assert.equal(codec.stringify(order), text);
