import assert from 'node:assert/strict';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { Checkout, CheckoutPlain, LineItem, PlainLineItem, PlainMoney, SdkMoney } from './features-class-transformer.models.js';
import { assertFeatureWire, checkoutInput, checkoutPlainInput, featureComparison } from './payloads.js';

const toModel = (value: unknown): Checkout => plainToInstance(Checkout, value);
const toPlain = (model: Checkout): unknown => instanceToPlain(model);

export async function createClassTransformerFeatureFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  if (adapter !== 'class-transformer') throw new TypeError(`Unsupported class-transformer adapter: ${adapter}`);
  const input = checkoutInput();
  const model = toModel(input.payload);
  return [checkoutPlainFixture(), featureComparison(input.name, input.payload, {
    'object-to-model': () => toModel(input.payload),
    'model-to-object': () => toPlain(model),
    'text-to-model': () => toModel(JSON.parse(input.text)),
    'model-to-text': () => JSON.stringify(toPlain(model)),
  }, async () => {
    const original = structuredClone(input.payload);
    const fromObject = toModel(input.payload);
    checkModel(fromObject);
    checkModel(toModel(JSON.parse(input.text)));
    assertFeatureWire(toPlain(fromObject), original);
    assert.equal(JSON.stringify(toPlain(fromObject)), input.text);
    assert.deepEqual(input.payload, original);
    checkModel(model);
  })];
}

function checkModel(checkout: Checkout): void {
  assert.ok(checkout instanceof Checkout);
  assert.ok(checkout.money instanceof SdkMoney);
  assert.ok(checkout.primary instanceof LineItem);
  assert.equal(checkout.code, 255);
  assert.equal(checkout.note, 'ok');
  assert.ok(checkout.when instanceof Date);
  assert.equal(checkout.when.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(checkout.flags.rush, 'yes');
  assert.equal(checkout.channel.kind, 'hold');
  assert.ok('until' in checkout.channel && checkout.channel.until instanceof Date);
  assert.ok(checkout.span[0] instanceof Date && checkout.span[1] instanceof Date);
  assert.equal(checkout.hold, null);
  assert.equal(checkout.bag?.lane, 'A');
}

/** The checkout without conversion: class-transformer builds the nested instances and keeps the strings. */
function checkoutPlainFixture(): ComparisonFixture {
  const input = checkoutPlainInput();
  const toModel = (value: unknown): CheckoutPlain => plainToInstance(CheckoutPlain, value);
  const toPlain = (value: CheckoutPlain): unknown => instanceToPlain(value);
  const model = toModel(input.payload);
  return featureComparison(input.name, input.payload, {
    'object-to-model': () => toModel(input.payload),
    'model-to-object': () => toPlain(model),
    'text-to-model': () => toModel(JSON.parse(input.text)),
    'model-to-text': () => JSON.stringify(toPlain(model)),
  }, async () => {
    const original = structuredClone(input.payload);
    for (const checked of [toModel(input.payload), toModel(JSON.parse(input.text))]) {
      assert.ok(checked instanceof CheckoutPlain);
      assert.ok(checked.money instanceof PlainMoney);
      assert.ok(checked.primary instanceof PlainLineItem);
      assert.equal(checked.when, '2026-01-01T00:00:00.000Z');
      assert.equal(checked.channel.kind, 'hold');
      assert.equal(checked.bag?.lane, 'A');
      assertFeatureWire(toPlain(checked), original);
    }
    assert.equal(JSON.stringify(toPlain(toModel(input.payload))), input.text);
    assert.deepEqual(input.payload, original);
  });
}
