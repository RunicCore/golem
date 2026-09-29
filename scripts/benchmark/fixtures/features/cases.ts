import assert from 'node:assert/strict';
import { registerIModelClass, requireObjectCodec } from '@exprtlabs/codegen/serde';
import {
  Address,
  Checkout,
  CombinedOrder,
  ComposeCustomer,
  Contact,
  ContactEmail,
  ContactPhone,
  Customer,
  LineItem,
  NestedOrder,
  ReuseContact,
  TaggedAccess,
  TaggedLineItem,
  TaggedMember,
} from './features.model.js';
import type {
  TJsonCombinedOrder,
  TJsonComposeCustomer,
  TJsonNestedOrder,
  TJsonReuseContact,
  TJsonTaggedAccess,
  TJsonCheckout,
} from './features.iobject.model.js';
import './features.iobject.model.generated.js';
import './sdk/index.js';
import type { Fixture, Operation } from './fixture-contract.js';

registerIModelClass('ReuseContact', ReuseContact);
registerIModelClass('Address', Address);
registerIModelClass('Customer', Customer);
registerIModelClass('LineItem', LineItem);
registerIModelClass('ContactEmail', ContactEmail);
registerIModelClass('ContactPhone', ContactPhone);
registerIModelClass('Contact', Contact);
registerIModelClass('NestedOrder', NestedOrder);
registerIModelClass('ComposeCustomer', ComposeCustomer);
registerIModelClass('TaggedMember', TaggedMember);
registerIModelClass('TaggedAccess', TaggedAccess);
registerIModelClass('TaggedLineItem', TaggedLineItem);
registerIModelClass('CombinedOrder', CombinedOrder);
registerIModelClass('Checkout', Checkout);

const reuseWire = {
  givenName: 'Ada',
  familyName: 'Lovelace',
  displayName: 'Ada Lovelace',
  alias: 'Ada',
  workEmail: 'ada@example.com',
  personalEmail: 'ada.personal@example.com',
  billingEmail: 'billing@example.com',
  homePhone: '+1-202-555-0100',
  workPhone: '+1-202-555-0199',
};

const composeWire = {
  home: { id: 'address-1', city: 'Hanoi', country: 'VN' },
  shipping: { city: 'Da Nang', country: 'VN' },
  draft: { city: 'Hue' },
  contact: { value: { kind: 'email' as const, address: 'ada@example.com' } },
};

const taggedWire = {
  projectName: 'Documentation',
  member: { id: 'member-1', name: 'Developer' },
  permissions: '0x1',
  budget: '12.50',
};

const combinedWire = {
  id: 'order-1',
  projectName: 'Documentation',
  billing: { id: 'address-1', city: 'Hanoi', country: 'VN' },
  shipping: { city: 'Da Nang', country: 'VN' },
  permissions: '0x1',
  items: Array.from({ length: 20 }, (_, index) => ({
    sku: `SKU-${index}`,
    quantity: index % 5 + 1,
    amount: `${index + 1}.50`,
  })),
};

const sdkExtendWire = {
  money: { amount: 12, currency: 'USD' },
  note: 'ok',
  code: 'ff',
  when: '2026-01-01T00:00:00.000Z',
  items: [{ sku: 'ABC' }],
  primary: { sku: 'ABC', quantity: 1, price: 2 },
  flags: { rush: 'yes' },
  channel: { kind: 'hold' as const, until: '2026-01-03T00:00:00.000Z' },
  span: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'] as [string, string],
  hold: null,
  bag: { lane: 'A' },
};

function nestedWire(count: number) {
  return {
    id: 'order-1',
    customer: { id: 'customer-1', name: 'Ada', home: { id: 'address-1', city: 'Hanoi', country: 'VN' } },
    items: Array.from({ length: count }, (_, index) => ({ sku: `SKU-${index}`, quantity: index % 5 + 1, price: index + 0.5 })),
  };
}

function detached(source: unknown, result: unknown): void {
  if (source === null || result === null || typeof source !== 'object' || typeof result !== 'object') return;
  // Discriminated union branches keep the input object; named IObjects and projections detach.
  if (source === result && !Array.isArray(source) && 'kind' in source) return;
  assert.notEqual(source, result, 'conversion must detach object and array containers');
  for (const key of Object.keys(source)) detached(Reflect.get(source, key), Reflect.get(result, key));
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

async function fixture<Model extends object, Wire extends object>(
  name: string,
  wire: Wire,
  decode: (input: Wire | string) => Promise<Model>,
  encode: (model: Model) => Promise<Wire>,
  encodeText: (model: Model) => Promise<string>,
  checkModel: (model: Model) => void,
  consumeModel: (model: Model) => number,
  consumeWire: (wire: Wire) => number,
  validateValue?: (model: Model) => boolean,
): Promise<Fixture> {
  const text = JSON.stringify(wire);
  const model = await decode(wire);
  const operations: Partial<Record<Operation, () => Promise<number>>> = {
    'object-to-model': async () => consumeModel(await decode(wire)),
    'model-to-object': async () => consumeWire(await encode(model)),
    'text-to-model': async () => consumeModel(await decode(text)),
    'model-to-text': async () => (await encodeText(model)).length,
  };
  if (validateValue) {
    operations.validate = async () => {
      assert.equal(validateValue(model), true);
      return 1;
    };
  }
  return {
    name,
    payload: structuredClone(wire),
    payloadBytes: Buffer.byteLength(text),
    operations,
    async verify() {
      const original = structuredClone(wire);
      const fromObject = await decode(wire);
      const fromText = await decode(text);
      checkModel(fromObject);
      checkModel(fromText);
      detached(wire, fromObject);
      detached(fromObject, fromText);
      const output = await encode(fromObject);
      assertRecord(output);
      assert.deepEqual(JSON.parse(JSON.stringify(output)), original);
      detached(fromObject, output);
      detached(wire, output);
      assert.equal(await encodeText(fromObject), text, 'JSON output is the same compact wire representation');
      assert.deepEqual(wire, original, 'deserialization must not modify its input');
      checkModel(fromObject);
      if (validateValue) {
        assert.equal(validateValue(fromObject), true);
        assert.equal(validateValue(fromText), true);
      }
    },
  };
}

function codec(name: string) {
  return requireObjectCodec(name);
}

function validateConvertedWire(name: string) {
  const objectCodec = requireObjectCodec(name);
  return (model: object) => objectCodec.validate(model);
}

export async function createFixtures(validation: boolean): Promise<readonly Fixture[]> {
  const fixtures: Fixture[] = [];
  fixtures.push(await fixture(
    'reuse',
    structuredClone(reuseWire),
    input => Promise.resolve(codec('JsonReuseContact').fromWireFormat(typeof input === 'string' ? JSON.parse(input) : input, { validate: false }) as TJsonReuseContact),
    model => Promise.resolve(codec('JsonReuseContact').toWireFormat(model, { validate: false }) as never),
    model => Promise.resolve(codec('JsonReuseContact').stringify(model, { validate: false })),
    model => {
      assertRecord(model);
      assert.equal(model.workEmail, 'ada@example.com');
      assert.equal(model.displayName, 'Ada Lovelace');
    },
    model => model.workEmail.length + model.homePhone.length,
    wire => wire.workEmail.length + wire.homePhone.length,
    validation ? model => codec('JsonReuseContact').validate(model) : undefined,
  ));
  for (const count of [10, 200]) {
    const wire = nestedWire(count);
    fixtures.push(await fixture(
      `nested-${count}`,
      wire,
      input => Promise.resolve(codec('JsonNestedOrder').fromWireFormat(typeof input === 'string' ? JSON.parse(input) : input, { validate: false }) as TJsonNestedOrder),
      model => Promise.resolve(codec('JsonNestedOrder').toWireFormat(model, { validate: false }) as never),
      model => Promise.resolve(codec('JsonNestedOrder').stringify(model, { validate: false })),
      model => {
        assertRecord(model);
        assertRecord(model.customer);
        assertRecord(model.customer.home);
        assert.equal(model.items.length, count);
        model.items.forEach((item, index) => {
          assertRecord(item);
          assert.deepEqual({ sku: item.sku, quantity: item.quantity, price: item.price }, wire.items[index]);
        });
      },
      model => model.items.length + model.customer.home.city.length,
      output => output.items.length + output.customer.home.city.length,
      validation ? model => codec('JsonNestedOrder').validate(model) : undefined,
    ));
  }
  fixtures.push(await fixture(
    'compose',
    structuredClone(composeWire),
    input => Promise.resolve(codec('JsonComposeCustomer').fromWireFormat(typeof input === 'string' ? JSON.parse(input) : input, { validate: false }) as TJsonComposeCustomer),
    model => Promise.resolve(codec('JsonComposeCustomer').toWireFormat(model, { validate: false }) as never),
    model => Promise.resolve(codec('JsonComposeCustomer').stringify(model, { validate: false })),
    model => {
      assertRecord(model);
      assertRecord(model.home);
      assertRecord(model.shipping);
      assertRecord(model.draft);
      assertRecord(model.contact);
      assertRecord(model.contact.value);
      assert.equal(model.home.id, 'address-1');
      assert.deepEqual(Object.keys(model.shipping), ['city', 'country']);
      assert.deepEqual(Object.keys(model.draft), ['city']);
      assert.equal(model.contact.value.kind, 'email');
    },
    model => model.home.city.length + model.shipping.city.length + model.draft.city!.length,
    wire => wire.home.city.length + wire.shipping.city.length + wire.draft.city.length,
    validation ? model => codec('JsonComposeCustomer').validate(model) : undefined,
  ));
  fixtures.push(await fixture(
    'tagged',
    structuredClone(taggedWire),
    input => Promise.resolve(codec('JsonTaggedAccess').fromWireFormat(typeof input === 'string' ? JSON.parse(input) : input, { validate: false }) as TJsonTaggedAccess),
    model => Promise.resolve(codec('JsonTaggedAccess').toWireFormat(model, { validate: false }) as never),
    model => Promise.resolve(codec('JsonTaggedAccess').stringify(model, { validate: false })),
    model => {
      assertRecord(model);
      assertRecord(model.member);
      assert.equal(model.permissions, 1);
      assert.equal(model.budget, 1250);
      assert.equal(model.member.name, 'Developer');
    },
    model => model.permissions + model.budget + model.member.name.length,
    wire => wire.permissions.length + wire.budget.length + wire.member.name.length,
    validation ? validateConvertedWire('JsonTaggedAccess') : undefined,
  ));
  fixtures.push(await fixture(
    'combined',
    structuredClone(combinedWire),
    input => Promise.resolve(codec('JsonCombinedOrder').fromWireFormat(typeof input === 'string' ? JSON.parse(input) : input, { validate: false }) as TJsonCombinedOrder),
    model => Promise.resolve(codec('JsonCombinedOrder').toWireFormat(model, { validate: false }) as never),
    model => Promise.resolve(codec('JsonCombinedOrder').stringify(model, { validate: false })),
    model => {
      assertRecord(model);
      assertRecord(model.billing);
      assertRecord(model.shipping);
      assert.equal(model.permissions, 1);
      assert.equal(model.items.length, 20);
      assert.equal(model.items[0].amount, 150);
      model.items.forEach(item => assertRecord(item));
    },
    model => model.items.length + model.items[0].amount + model.permissions,
    wire => wire.items.length + wire.items[0].amount.length + wire.permissions.length,
    validation ? validateConvertedWire('JsonCombinedOrder') : undefined,
  ));
  fixtures.push(await fixture(
    'sdk-extend',
    structuredClone(sdkExtendWire),
    input => Promise.resolve(codec('JsonCheckout').fromWireFormat(typeof input === 'string' ? JSON.parse(input) : input, { validate: false }) as TJsonCheckout),
    model => Promise.resolve(codec('JsonCheckout').toWireFormat(model, { validate: false }) as never),
    model => Promise.resolve(codec('JsonCheckout').stringify(model, { validate: false })),
    model => {
      assertRecord(model);
      assertRecord(model.money);
      assert.equal(model.note, 'ok');
      assert.equal(model.code, 255);
      assert.ok(model.when instanceof Date);
      assert.equal(model.items[0].sku, 'ABC');
      assertRecord(model.primary);
      assert.equal(model.primary.sku, 'ABC');
      assert.equal(model.flags.rush, 'yes');
      assert.equal(model.channel.kind, 'hold');
      if (model.channel.kind === 'hold') assert.ok(model.channel.until instanceof Date);
      assert.ok(model.span[0] instanceof Date);
      assert.ok(model.span[1] instanceof Date);
      assert.equal(model.hold, null);
      assert.equal(model.bag?.lane, 'A');
      assert.equal(Object.hasOwn(model, 'memo'), false);
    },
    model => model.note.length + model.code + model.items.length,
    wire => wire.note.length + wire.code.length + wire.items.length,
    validation ? (model) => codec('JsonCheckout').validate(model) : undefined,
  ));

  if (validation) {
    const checkoutCodec = codec('JsonCheckout');
    const extra = checkoutCodec.fromWireFormat({ ...sdkExtendWire, money: { amount: 12, currency: 'XXX' } }, { validate: false }) as TJsonCheckout;
    assert.equal(checkoutCodec.validate(extra, { failFast: false }), false);
    const nested = checkoutCodec.fromWireFormat({ ...sdkExtendWire, money: { amount: 12, currency: 'usd' } }, { validate: false }) as TJsonCheckout;
    assert.equal(checkoutCodec.validate(nested, { failFast: false }), false);
    const blank = checkoutCodec.fromWireFormat({ ...sdkExtendWire, note: '  ' }, { validate: false }) as TJsonCheckout;
    assert.equal(checkoutCodec.validate(blank, { failFast: false }), false);
    assert.throws(() => checkoutCodec.parse(JSON.stringify({ ...sdkExtendWire, code: 'zz' })));
    const collected = checkoutCodec.fromWireFormat({
      ...sdkExtendWire,
      money: { amount: -1, currency: 'usd' },
      note: '  ',
    }, { validate: false }) as TJsonCheckout;
    assert.equal(checkoutCodec.validate(collected, { failFast: false }), false);
  }

  const invalid = { ...taggedWire, permissions: '0x4' };
  const draft = codec('TaggedAccess').fromWireFormat(invalid, { validate: false, construct: TaggedAccess }) as InstanceType<typeof TaggedAccess>;
  assert.ok(draft instanceof TaggedAccess);
  assert.ok(draft.member instanceof TaggedMember);
  if (validation) {
    const { getValidator } = await import('@exprtlabs/codegen/validation');
    assert.equal(await getValidator(draft).validate(), false);
  } else {
    assert.equal(draft.permissions, 4);
    assert.deepEqual(
      JSON.parse(JSON.stringify(codec('TaggedAccess').toWireFormat(draft, { validate: false }))),
      invalid,
    );
  }
  return fixtures;
}
