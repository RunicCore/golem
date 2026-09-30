import assert from 'node:assert/strict';
import { registerIModelClass, requireObjectCodec } from '@exprtlabs/golem/serde';
import type { Adapter, ComparisonFixture } from './fixture-contract.js';
import { Checkout, LineItem } from './features.model.js';
import './sdk/index.js';
import { assertFeatureWire, checkoutInput, featureComparison } from './payloads.js';

registerIModelClass('LineItem', LineItem);
registerIModelClass('Checkout', Checkout);

function options(validation: boolean, construct?: new (values?: never) => object): { readonly validate?: false; readonly construct?: new (values?: never) => object } {
  return { ...(validation ? {} : { validate: false as const }), ...(construct ? { construct } : {}) };
}

function validationFor(adapter: Adapter): boolean {
  if (adapter === 'codegen') return false;
  if (adapter === 'codegen-runtime' || adapter === 'codegen-standalone') return true;
  throw new TypeError(`Unsupported codegen adapter: ${adapter}`);
}

const codec = () => requireObjectCodec('Checkout');

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

export async function createCodegenFeatureFixtures(adapter: Adapter): Promise<readonly ComparisonFixture[]> {
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
  return [featureComparison(input.name, input.payload, {
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
