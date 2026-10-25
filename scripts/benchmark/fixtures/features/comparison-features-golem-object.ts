import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { codecIdOf } from './codec-id.js';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import type { TJsonCheckout, TJsonCheckoutPlain, TJsonSerdeMany, TJsonSerdeNone } from './features.iobject.model.js';
import './features.iobject.model.generated.js';
import './sdk/index.js';
import { assertFeatureWire, assertSerdeModel, checkoutInput, checkoutPlainInput, checkoutPlainInvalidWires, featureComparison, serdeComparison, serdeInput, serdeInvalidWires, type SerdeDensity } from './payloads.js';

const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;

/** The serde payloads of the golem cost table, as plain objects. A converting field must round-trip exactly; a validating mode rejects a broken field of each kind. */
function serdeFixtures(validation: boolean): readonly ComparisonFixture[] {
  return (['serde-none', 'serde-many'] as const).map((name: SerdeDensity) => {
    const input = serdeInput(name);
    const codec = requireObjectCodec<TJsonSerdeMany | TJsonSerdeNone>(codecIdOf(name === 'serde-many' ? 'TJsonSerdeMany' : 'TJsonSerdeNone'));
    const model = codec.parse(input.text);
    return serdeComparison(name, input.payload, {
      'object-to-model': () => codec.fromWireFormat(input.payload),
      'model-to-object': () => codec.toWireFormat(model),
      'text-to-model': () => codec.parse(input.text),
      'model-to-text': () => codec.stringify(model),
      ...(validation ? {
        validate: () => {
          if (!codec.validate(model)) throw new Error('IObject validate rejected a valid fixture');
          return true;
        },
      } : {}),
    }, async () => {
      const original = structuredClone(input.payload);
      const fromObject = codec.fromWireFormat(input.payload);
      const fromText = codec.parse(input.text);
      assert.equal(Object.getPrototypeOf(fromObject), Object.prototype);
      assertSerdeModel(name, fromObject);
      assertSerdeModel(name, fromText);
      assertFeatureWire(codec.toWireFormat(fromObject), original);
      assert.equal(codec.stringify(fromObject), input.text, 'JSON output is the same compact wire representation');
      assert.deepEqual(input.payload, original);
      if (!validation) return;
      assert.equal(codec.validate(fromObject), true);
      for (const invalid of serdeInvalidWires(name)) {
        assert.throws(() => codec.fromWireFormat(invalid), validationError);
        assert.throws(() => codec.parse(JSON.stringify(invalid)), validationError);
      }
    });
  });
}

/** The checkout without conversion, as plain objects: the wire value is the model. */
function checkoutPlainFixture(validation: boolean): ComparisonFixture {
  const input = checkoutPlainInput();
  // #region checkout-plain-calls
  const checkout = requireObjectCodec<TJsonCheckoutPlain>(codecIdOf('TJsonCheckoutPlain'));
  const model = checkout.parse(input.text);
  const timed = {
    'text-to-model': () => checkout.parse(input.text),
    'model-to-text': () => checkout.stringify(model),
    validate: () => {
      if (!checkout.validate(model)) throw new Error('IObject validate rejected a valid fixture');
      return true;
    },
  };
  // #endregion checkout-plain-calls
  const conversions = {
    'object-to-model': () => checkout.fromWireFormat(input.payload),
    'model-to-object': () => checkout.toWireFormat(model),
  };
  const operations = validation ? { ...timed, ...conversions } : { 'text-to-model': timed['text-to-model'], 'model-to-text': timed['model-to-text'], ...conversions };
  return featureComparison(input.name, input.payload, operations, async () => {
    const original = structuredClone(input.payload);
    const fromText = checkout.parse(input.text);
    assert.equal(Object.getPrototypeOf(fromText), Object.prototype);
    assert.deepEqual(fromText, original);
    assert.equal(checkout.stringify(fromText), input.text, 'adapter output must retain the compact JSON representation');
    assert.deepEqual(checkout.fromWireFormat(input.payload), original);
    assert.deepEqual(checkout.toWireFormat(fromText), original);
    assert.deepEqual(input.payload, original);
    if (!validation) return;
    assert.equal(checkout.validate(fromText), true);
    const invalid = checkoutPlainInvalidWires();
    for (const wire of [...invalid.broken, invalid.unknownProperty]) {
      assert.throws(() => checkout.parse(JSON.stringify(wire)), validationError);
      assert.equal(checkout.validate(wire), false);
      assert.throws(() => checkout.stringify(wire as never), validationError);
    }
  });
}

export async function createGolemObjectFeatureFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'golem-object' && adapter !== 'golem-object-off') throw new TypeError(`Unsupported Golem IObject adapter: ${adapter}`);
  const validation = adapter === 'golem-object';
  const input = checkoutInput();
  // #region calls
  // Resolve the codec once; timed calls do only the conversion.
  const checkout = requireObjectCodec<TJsonCheckout>(codecIdOf('TJsonCheckout'));
  const model = checkout.parse(input.text);
  const timed = {
    'text-to-model': () => checkout.parse(input.text),
    'model-to-text': () => checkout.stringify(model),
    validate: () => {
      if (!checkout.validate(model)) throw new Error('IObject validate rejected a valid fixture');
      return true;
    },
  };
  // #endregion calls
  const conversions = {
    'object-to-model': () => checkout.fromWireFormat(input.payload),
    'model-to-object': () => checkout.toWireFormat(model),
  };
  // A build with validation off has no validators to call, so it has no validate.
  const operations = validation ? { ...timed, ...conversions } : { 'text-to-model': timed['text-to-model'], 'model-to-text': timed['model-to-text'], ...conversions };
  return [...serdeFixtures(validation), checkoutPlainFixture(validation), featureComparison(input.name, input.payload, operations, async () => {
    const original = structuredClone(input.payload);
    const fromText = checkout.parse(input.text);
    assert.equal(Object.getPrototypeOf(fromText), Object.prototype);
    assert.ok(fromText.when instanceof Date);
    assert.equal(fromText.code, 255);
    assert.ok(fromText.channel.kind === 'hold' && fromText.channel.until instanceof Date);
    assert.equal(checkout.stringify(fromText), input.text, 'adapter output must retain the compact JSON representation');
    assertFeatureWire(checkout.toWireFormat(fromText), original);
    const decoded = checkout.fromWireFormat(input.payload);
    assert.ok(decoded.when instanceof Date);
    assert.equal(decoded.code, 255);
    assertFeatureWire(checkout.toWireFormat(decoded), original);
    // A build with validation off has no validators: only the valid paths are checked.
    if (!validation) {
      assert.deepEqual(input.payload, original);
      return;
    }
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
