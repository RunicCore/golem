// The consumer app of tests/serde-features.acceptance.ts. It runs in the built project, in its own process, because it registers
// codecs in the process-wide registry. A failed claim throws; a run that passes prints the names of its cases as a JSON array.
import assert from 'node:assert/strict';
import { registerIModelClass, requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';
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
  TJsonCheckout,
  TJsonCombinedOrder,
  TJsonComposeCustomer,
  TJsonNestedOrder,
  TJsonReuseContact,
  TJsonTaggedAccess,
} from './features.iobject.model.js';
import './features.iobject.model.generated.js';
import './sdk/index.js';

const validation = process.argv[2] === 'validating';

registerIModelClass('TReuseContact', ReuseContact);
registerIModelClass('TAddress', Address);
registerIModelClass('TCustomer', Customer);
registerIModelClass('TLineItem', LineItem);
registerIModelClass('TContactEmail', ContactEmail);
registerIModelClass('TContactPhone', ContactPhone);
registerIModelClass('TContact', Contact);
registerIModelClass('TNestedOrder', NestedOrder);
registerIModelClass('TComposeCustomer', ComposeCustomer);
registerIModelClass('TaggedMember', TaggedMember);
registerIModelClass('TaggedAccess', TaggedAccess);
registerIModelClass('TaggedLineItem', TaggedLineItem);
registerIModelClass('TCombinedOrder', CombinedOrder);
registerIModelClass('TCheckout', Checkout);

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

const checkoutWire = {
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

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

/** Every object and array container of `result` is a new one; a discriminated union branch keeps its input object. */
function assertDetached(source: unknown, result: unknown): void {
  if (source === null || result === null || typeof source !== 'object' || typeof result !== 'object') return;
  if (source === result && !Array.isArray(source) && 'kind' in source) return;
  assert.notEqual(source, result, 'conversion must detach object and array containers');
  for (const key of Object.keys(source)) assertDetached(Reflect.get(source, key), Reflect.get(result, key));
}

const names: string[] = [];

/** Decodes the wire from an object and from text, encodes it back, and checks that the codec changed no input and kept no alias. */
function roundTrip<Model extends object>(name: string, codecName: string, wire: object, assertModel: (model: Model) => void): void {
  const objectCodec = requireObjectCodec(codecName);
  const original = structuredClone(wire);
  const text = JSON.stringify(wire);
  const fromObject = objectCodec.fromWireFormat(wire, { validate: false }) as Model;
  const fromText = objectCodec.fromWireFormat(JSON.parse(text), { validate: false }) as Model;
  assertModel(fromObject);
  assertModel(fromText);
  assertDetached(wire, fromObject);
  assertDetached(fromObject, fromText);
  const output = objectCodec.toWireFormat(fromObject, { validate: false });
  assertRecord(output);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), original);
  assertDetached(fromObject, output);
  assertDetached(wire, output);
  assert.equal(objectCodec.stringify(fromObject, { validate: false }), text, 'JSON output is the same compact wire representation');
  assert.deepEqual(wire, original, 'deserialization must not modify its input');
  assertModel(fromObject);
  if (validation) {
    assert.equal(objectCodec.validate(fromObject), true);
    assert.equal(objectCodec.validate(fromText), true);
  }
  names.push(name);
}

roundTrip<TJsonReuseContact>('reuse', 'TJsonReuseContact', reuseWire, model => {
  assertRecord(model);
  assert.equal(model.workEmail, 'ada@example.com');
  assert.equal(model.displayName, 'Ada Lovelace');
});

for (const count of [10, 200]) {
  const wire = nestedWire(count);
  roundTrip<TJsonNestedOrder>(`nested-${count}`, 'TJsonNestedOrder', wire, model => {
    assertRecord(model);
    assertRecord(model.customer);
    assertRecord(model.customer.home);
    assert.equal(model.items.length, count);
    model.items.forEach((item, index) => {
      assertRecord(item);
      assert.deepEqual({ sku: item.sku, quantity: item.quantity, price: item.price }, wire.items[index]);
    });
  });
}

roundTrip<TJsonComposeCustomer>('compose', 'TJsonComposeCustomer', composeWire, model => {
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
});

roundTrip<TJsonTaggedAccess>('tagged', 'TJsonTaggedAccess', taggedWire, model => {
  assertRecord(model);
  assertRecord(model.member);
  assert.equal(model.permissions, 1);
  assert.equal(model.budget, 1250);
  assert.equal(model.member.name, 'Developer');
});

roundTrip<TJsonCombinedOrder>('combined', 'TJsonCombinedOrder', combinedWire, model => {
  assertRecord(model);
  assertRecord(model.billing);
  assertRecord(model.shipping);
  assert.equal(model.permissions, 1);
  assert.equal(model.items.length, 20);
  assert.equal(model.items[0].amount, 150);
  model.items.forEach(item => assertRecord(item));
});

roundTrip<TJsonCheckout>('sdk-extend', 'TJsonCheckout', checkoutWire, model => {
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
});

if (validation) {
  const checkoutCodec = requireObjectCodec('TJsonCheckout');
  const decode = (wire: object) => checkoutCodec.fromWireFormat(wire, { validate: false }) as TJsonCheckout;
  assert.equal(checkoutCodec.validate(decode({ ...checkoutWire, money: { amount: 12, currency: 'XXX' } }), { failFast: false }), false);
  assert.equal(checkoutCodec.validate(decode({ ...checkoutWire, money: { amount: 12, currency: 'usd' } }), { failFast: false }), false);
  assert.equal(checkoutCodec.validate(decode({ ...checkoutWire, note: '  ' }), { failFast: false }), false);
  assert.throws(() => checkoutCodec.parse(JSON.stringify({ ...checkoutWire, code: 'zz' })));
  assert.equal(checkoutCodec.validate(decode({ ...checkoutWire, money: { amount: -1, currency: 'usd' }, note: '  ' }), { failFast: false }), false);
}

const invalid = { ...taggedWire, permissions: '0x4' };
const draft = requireObjectCodec('TTaggedAccess').fromWireFormat(invalid, { validate: false, construct: TaggedAccess }) as InstanceType<typeof TaggedAccess>;
assert.ok(draft instanceof TaggedAccess);
assert.ok(draft.member instanceof TaggedMember);
if (validation) {
  assert.equal(await getValidator(draft).validate(), false);
} else {
  assert.equal(draft.permissions, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(requireObjectCodec('TTaggedAccess').toWireFormat(draft, { validate: false }))), invalid);
}

process.stdout.write(JSON.stringify(names));
