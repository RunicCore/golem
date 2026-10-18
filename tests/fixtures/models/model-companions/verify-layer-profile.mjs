import assert from 'node:assert/strict';
import { isComputedProp } from 'mobx';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
import { decodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { TOrderBaseModel } from './build/order.model.generated.js';

const [, , codecId, expectation] = process.argv;
const codec = requireObjectCodec(codecId);
const shortCurrency = JSON.stringify({ total: { currency: 'US' } });

if (expectation === 'validates') {
  assert.throws(() => codec.parse(shortCurrency));
  const order = decodeGeneratedModel(TOrderBaseModel, { total: { currency: 'USD' } });
  assert.equal(isComputedProp(getValidator(order), 'valid'), true, 'the MobX hook makes the validator observable');
} else {
  assert.deepEqual(codec.parse(shortCurrency), { total: { currency: 'US' } });
}
