import assert from 'node:assert/strict';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validateOrReject, ValidationError } from 'class-validator';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { Checkout, CheckoutPlain, LineItem, PlainLineItem, PlainMoney } from './features-class-validator.models.js';
import { assertFeatureWire, checkoutInput, checkoutPlainInput, checkoutPlainInvalidWires, featureComparison } from './payloads.js';

function isValidationFailure(error: unknown): boolean {
  const hasConstraint = (item: ValidationError): boolean => Object.keys(item.constraints ?? {}).length > 0 || (item.children ?? []).some(hasConstraint);
  return Array.isArray(error) && error.length > 0 && error.every(item => item instanceof ValidationError) && error.some(hasConstraint);
}

async function toModel(value: unknown): Promise<Checkout> {
  const model = plainToInstance(Checkout, value);
  await validateOrReject(model);
  return model;
}

async function toPlain(model: Checkout): Promise<unknown> {
  await validateOrReject(model);
  return instanceToPlain(model);
}

export async function createClassValidatorFeatureFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'class-validator') throw new TypeError(`Unsupported class-validator adapter: ${adapter}`);
  const input = checkoutInput();
  const model = await toModel(input.payload);
  return [await checkoutPlainFixture(), featureComparison(input.name, input.payload, {
    'object-to-model': () => toModel(input.payload),
    'model-to-object': () => toPlain(model),
    'text-to-model': () => toModel(JSON.parse(input.text)),
    'model-to-text': async () => JSON.stringify(await toPlain(model)),
    validate: async () => {
      await validateOrReject(model);
      return true;
    },
  }, async () => {
    const original = structuredClone(input.payload);
    const checkout = await toModel(input.payload);
    assert.ok(checkout instanceof Checkout);
    assert.ok(await toModel(JSON.parse(input.text)) instanceof Checkout);
    assert.ok(checkout.primary instanceof LineItem);
    assert.equal(checkout.code, 255);
    assert.equal(checkout.note, 'ok');
    assert.ok(checkout.when instanceof Date);
    assert.ok('until' in checkout.channel && checkout.channel.until instanceof Date);
    assert.ok(checkout.span[0] instanceof Date);
    assert.equal(checkout.hold, null);
    assert.equal(checkout.bag?.lane, 'A');
    assertFeatureWire(await toPlain(checkout), original);
    assert.deepEqual(input.payload, original);
    const invalid = { ...structuredClone(original), money: { amount: 12, currency: 'XXX' } };
    await assert.rejects(() => toModel(invalid), isValidationFailure);
  })];
}

/**
 * The checkout without conversion: class-transformer builds the nested instances and class-validator checks the rules.
 * It does not reject an unknown property, so the proof below leaves that variant out (R1).
 */
async function checkoutPlainFixture(): Promise<ComparisonFixture> {
  const input = checkoutPlainInput();
  const toModel = async (value: unknown): Promise<CheckoutPlain> => {
    const checkout = plainToInstance(CheckoutPlain, value);
    await validateOrReject(checkout);
    return checkout;
  };
  const toPlain = async (checkout: CheckoutPlain): Promise<unknown> => {
    await validateOrReject(checkout);
    return instanceToPlain(checkout);
  };
  const model = plainToInstance(CheckoutPlain, input.payload);
  await validateOrReject(model);
  return featureComparison(input.name, input.payload, {
    'object-to-model': () => toModel(input.payload),
    'model-to-object': () => toPlain(model),
    'text-to-model': () => toModel(JSON.parse(input.text)),
    'model-to-text': async () => JSON.stringify(await toPlain(model)),
    validate: async () => {
      await validateOrReject(model);
      return true;
    },
  }, async () => {
    const original = structuredClone(input.payload);
    for (const checked of [await toModel(input.payload), await toModel(JSON.parse(input.text))]) {
      assert.ok(checked instanceof CheckoutPlain);
      assert.ok(checked.money instanceof PlainMoney);
      assert.ok(checked.primary instanceof PlainLineItem);
      assertFeatureWire(await toPlain(checked), original);
    }
    assert.equal(JSON.stringify(await toPlain(await toModel(input.payload))), input.text);
    assert.deepEqual(input.payload, original);
    for (const wire of checkoutPlainInvalidWires().broken) await assert.rejects(() => toModel(wire), isValidationFailure);
  });
}
