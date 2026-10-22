import assert from 'node:assert/strict';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { registerIModelClass, requireObjectCodec } from '@exprtlabs/golem/serde';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { Checkout, CheckoutPlain, LineItem, SerdeMany, SerdeManyLine, SerdeNone, SerdeNoneLine } from './features.model.js';
import './sdk/index.js';
import { assertFeatureWire, assertSerdeModel, checkoutInput, checkoutPlainInput, checkoutPlainInvalidWires, featureComparison, serdeComparison, serdeInput, serdeInvalidWires, type SerdeDensity } from './payloads.js';

registerIModelClass('TLineItem', LineItem);
registerIModelClass('TCheckout', Checkout);
registerIModelClass('TCheckoutPlain', CheckoutPlain);
registerIModelClass('TSerdeManyLine', SerdeManyLine);
registerIModelClass('TSerdeMany', SerdeMany);
registerIModelClass('TSerdeNoneLine', SerdeNoneLine);
registerIModelClass('TSerdeNone', SerdeNone);

function options(validation: boolean, construct?: new (values?: never) => object): { readonly validate?: false; readonly construct?: new (values?: never) => object } {
  return { ...(validation ? {} : { validate: false as const }), ...(construct ? { construct } : {}) };
}

function validationFor(adapter: Adapter): boolean {
  if (adapter === 'golem') return false;
  if (adapter === 'golem-validated') return true;
  throw new TypeError(`Unsupported golem adapter: ${adapter}`);
}

const codec = () => requireObjectCodec('TCheckout');

function checkConverted(model: object): void {
  assert.ok(model instanceof Checkout);
  assert.ok(model.primary instanceof LineItem);
  assert.equal(model.note, 'ok');
  assert.equal(model.code, 255);
  assert.ok(model.when instanceof Date);
  assert.equal(model.money.amount, 12);
  assert.equal(model.money.currency, 'USD');
  assert.equal(model.flags.rush, 'yes');
  assert.ok(model.channel.kind === 'hold' && model.channel.until instanceof Date);
  assert.ok(model.span[0] instanceof Date && model.span[1] instanceof Date);
  assert.equal(model.hold, null);
  assert.equal(model.bag?.lane, 'A');
  assert.equal(Object.hasOwn(model, 'memo'), false);
}

const validationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;

/** The checkout without conversion, as a class model: dates stay strings, and the class instance holds the wire values. */
function checkoutPlainFixture(validation: boolean): ComparisonFixture {
  const input = checkoutPlainInput();
  // #region checkout-plain-calls
  // Resolve the codec and options once, as the other libraries' fixtures do; timed calls do only the conversion.
  const checkout = requireObjectCodec('TCheckoutPlain');
  const decodeOptions = options(validation, CheckoutPlain);
  const encodeOptions = options(validation);
  const model = checkout.fromWireFormat(input.payload, decodeOptions);
  const timed = {
    'object-to-model': () => checkout.fromWireFormat(input.payload, decodeOptions),
    'model-to-object': () => checkout.toWireFormat(model as never, encodeOptions),
    'text-to-model': () => checkout.parse(input.text, decodeOptions),
    'model-to-text': () => checkout.stringify(model as never, encodeOptions),
    ...(validation ? {
      validate: () => {
        if (!checkout.validate(model as never)) throw new Error('Class validate rejected a valid fixture');
        return true;
      },
    } : {}),
  };
  // #endregion checkout-plain-calls
  return featureComparison(input.name, input.payload, timed, async () => {
    const original = structuredClone(input.payload);
    const fromObject = checkout.fromWireFormat(input.payload, decodeOptions);
    const fromText = checkout.parse(input.text, decodeOptions);
    assert.ok(fromObject instanceof CheckoutPlain && fromText instanceof CheckoutPlain);
    assert.deepEqual(JSON.parse(JSON.stringify(fromObject)), original);
    assert.deepEqual(JSON.parse(JSON.stringify(fromText)), original);
    assertFeatureWire(checkout.toWireFormat(fromObject as never, encodeOptions), original);
    assert.equal(checkout.stringify(fromObject as never, encodeOptions), input.text, 'JSON output is the same compact wire representation');
    assert.deepEqual(input.payload, original);
    if (!validation) return;
    assert.equal(checkout.validate(fromObject), true);
    const invalid = checkoutPlainInvalidWires();
    for (const wire of [...invalid.broken, invalid.unknownProperty]) {
      assert.throws(() => checkout.fromWireFormat(wire, decodeOptions), validationError);
      assert.throws(() => checkout.parse(JSON.stringify(wire), decodeOptions), validationError);
    }
  });
}

/** The serde payloads of the golem cost table, as class models. A converting field must round-trip exactly; a validating mode rejects a broken field of each kind. */
function serdeFixtures(validation: boolean): readonly ComparisonFixture[] {
  return (['serde-none', 'serde-many'] as const).map((name: SerdeDensity) => {
    const input = serdeInput(name);
    const construct = name === 'serde-many' ? SerdeMany : SerdeNone;
    const codec = requireObjectCodec(name === 'serde-many' ? 'TSerdeMany' : 'TSerdeNone');
    const decodeOptions = options(validation, construct);
    const encodeOptions = options(validation);
    const model = codec.fromWireFormat(input.payload, decodeOptions);
    return serdeComparison(name, input.payload, {
      'object-to-model': () => codec.fromWireFormat(input.payload, decodeOptions),
      'model-to-object': () => codec.toWireFormat(model as never, encodeOptions),
      'text-to-model': () => codec.parse(input.text, decodeOptions),
      'model-to-text': () => codec.stringify(model as never, encodeOptions),
      ...(validation ? {
        validate: () => {
          if (!codec.validate(model)) throw new Error('Class validate rejected a valid fixture');
          return true;
        },
      } : {}),
    }, async () => {
      const original = structuredClone(input.payload);
      const fromObject = codec.fromWireFormat(input.payload, decodeOptions);
      const fromText = codec.parse(input.text, decodeOptions);
      assert.ok(fromObject instanceof construct && fromText instanceof construct);
      assertSerdeModel(name, fromObject);
      assertSerdeModel(name, fromText);
      assertFeatureWire(codec.toWireFormat(fromObject as never, encodeOptions), original);
      assert.equal(codec.stringify(fromObject as never, encodeOptions), input.text, 'JSON output is the same compact wire representation');
      assert.deepEqual(input.payload, original);
      if (!validation) return;
      assert.equal(codec.validate(fromObject), true);
      for (const invalid of serdeInvalidWires(name)) {
        assert.throws(() => codec.fromWireFormat(invalid, decodeOptions), validationError);
        assert.throws(() => codec.parse(JSON.stringify(invalid), decodeOptions), validationError);
      }
    });
  });
}

export async function createGolemFeatureFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
  const validation = validationFor(adapter);
  const input = checkoutInput();
  // #region calls
  // Resolve the codec and options once, as the other libraries' fixtures do; timed calls do only the conversion.
  const checkout = codec();
  const decodeOptions = options(validation, Checkout);
  const encodeOptions = options(validation);
  const decode = (): object => checkout.fromWireFormat(input.payload, decodeOptions) as object;
  const decodeText = (text: string, checked = validation): object => checkout.parse(text, options(checked, Checkout)) as object;
  const model = decode();
  return [...serdeFixtures(validation), checkoutPlainFixture(validation), featureComparison(input.name, input.payload, {
    'object-to-model': decode,
    'model-to-object': () => checkout.toWireFormat(model as never, encodeOptions),
    'text-to-model': () => checkout.parse(input.text, decodeOptions),
    'model-to-text': () => checkout.stringify(model as never, encodeOptions),
    ...(validation ? {
      validate: () => {
        if (!checkout.validate(model as never)) throw new Error('Class validate rejected a valid fixture');
        return true;
      },
    } : {}),
  // #endregion calls
  }, async () => {
    const original = structuredClone(input.payload);
    const fromObject = decode();
    checkConverted(fromObject);
    checkConverted(decodeText(input.text));
    checkConverted(model);
    assertFeatureWire(codec().toWireFormat(fromObject as never, options(validation)), original);
    assert.deepEqual(input.payload, original);
    const invalid = { ...structuredClone(original), money: { amount: 12, currency: 'XXX' } };
    if (!validation) {
      decodeText(JSON.stringify(invalid), false);
      return;
    }
    assert.equal(codec().validate(fromObject as never), true);
    assert.equal(codec().validate(codec().fromWireFormat(invalid, options(false, Checkout)) as never), false);
    assert.throws(() => codec().fromWireFormat(invalid, options(true, Checkout)));
    assert.throws(() => decodeText(JSON.stringify(invalid), true));
    assert.throws(() => codec().parse(JSON.stringify({ ...original, code: 'zz' })));
  })];
}
