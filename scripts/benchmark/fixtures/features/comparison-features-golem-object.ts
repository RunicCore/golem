import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import type { TJsonCheckout } from './features.iobject.model.js';
import './features.iobject.model.generated.js';
import './sdk/index.js';
import { assertFeatureWire, checkoutInput, featureComparison } from './payloads.js';

export async function createGolemObjectFeatureFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'golem-object') throw new TypeError(`Unsupported Golem IObject adapter: ${adapter}`);
  const input = checkoutInput();
  // #region calls
  // Resolve the codec once, as the other libraries' fixtures do; timed calls do only the conversion.
  const checkout = requireObjectCodec<TJsonCheckout>('TJsonCheckout');
  const model = checkout.parse(input.text);
  return [featureComparison(input.name, input.payload, {
    'text-to-model': () => checkout.parse(input.text),
    'model-to-text': () => checkout.stringify(model),
    validate: () => {
      if (!checkout.validate(model)) throw new Error('IObject validate rejected a valid fixture');
      return true;
    },
  // #endregion calls
  }, async () => {
    const original = structuredClone(input.payload);
    const fromText = checkout.parse(input.text);
    assert.equal(Object.getPrototypeOf(fromText), Object.prototype);
    assert.ok(fromText.when instanceof Date);
    assert.equal(fromText.code, 255);
    assert.ok(fromText.channel.kind === 'hold' && fromText.channel.until instanceof Date);
    assert.equal(checkout.stringify(fromText), input.text, 'adapter output must retain the compact JSON representation');
    assertFeatureWire(checkout.toWireFormat(fromText), original);
    const invalid = { ...structuredClone(original), money: { amount: 12, currency: 'XXX' } };
    const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;
    assert.throws(() => checkout.parse(JSON.stringify(invalid)), validationError);
    assert.throws(() => checkout.parse(JSON.stringify({ ...structuredClone(original), extra: 1 })), validationError, 'unknown property rejected');
    // The timed validate and stringify check the model; an invalid model fails both.
    const invalidModel = { ...fromText, note: '  ' };
    assert.equal(checkout.validate(invalidModel), false);
    assert.throws(() => checkout.stringify(invalidModel), validationError);
    assert.deepEqual(input.payload, original);
  })];
}
