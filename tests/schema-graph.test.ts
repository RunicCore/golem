import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph, emitCodecDeclarationTable, codecPublicId } from '@exprtlabs/golem/internal/schema-graph';
import { emitCodecRuntime, emitGraphStringify } from '@exprtlabs/golem/internal/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';
import * as serde from '@exprtlabs/golem/serde';
import { LibError } from '@exprtlabs/golem/errors';
import { instantiate, instantiateRuntime } from './emitted-runtime.js';
import { compileValidationPlanBinding } from './support/compiled-validators.js';

const money: ModelTypeDescriptor = {
  kind: 'object',
  properties: {
    currency: { kind: 'string' },
    value: { kind: 'string' },
  },
  required: ['currency', 'value'],
  additionalProperties: false,
};

const payment: ModelTypeDescriptor = {
  kind: 'object',
  properties: {
    id: { kind: 'string' },
    amount: { kind: 'reference', name: 'Money' },
    note: { kind: 'string' },
  },
  required: ['id', 'amount', 'note'],
  additionalProperties: false,
};

/** Emits the runtime with each validator named after its root, as the text a test reads needs no validators module. */
function emitRuntime(graph: Parameters<typeof emitCodecRuntime>[0]): string {
  return emitCodecRuntime(graph, { validatorName: (id) => `validate_${id.replace(/[^\w$]/g, '_')}` });
}

test('schema graph interns nested objects once and stringify composes by call', () => {
  const graph = createSchemaGraph();
  graph.intern(money, 'Money');
  graph.intern(payment, 'Payment', true);
  graph.intern(
    {
      kind: 'object',
      properties: { currency: { kind: 'string' }, value: { kind: 'string' } },
      required: ['currency', 'value'],
      additionalProperties: false,
    },
    undefined,
    false,
  );
  graph.seal();
  const names = [...graph.nodes.values()].map((node) => node.name);
  assert.equal(names.filter((name) => name === 'Money').length, 1);
  const moneyNode = [...graph.nodes.values()].find((node) => node.name === 'Money');
  assert.equal(moneyNode?.sameSchema, true);
  const source = emitGraphStringify(graph);
  const paymentBody = source.slice(source.indexOf('function stringifyPayment'), source.indexOf('function stringify', source.indexOf('function stringifyPayment') + 1) === -1
    ? source.length
    : source.indexOf('\nfunction stringify', source.indexOf('function stringifyPayment') + 1));
  assert.match(paymentBody, /stringifyMoney\(/, 'one stringify function per interned node: Payment calls stringifyMoney instead of inlining its fields');
  assert.doesNotMatch(paymentBody, /stringifyJsonString\(value\["currency"\]/, 'Money fields are not inlined into stringifyPayment');
  // Budget: the codegen never emits a redundant, unconditionally-true guard clause.
  assert.doesNotMatch(source, /if \(true\)/, 'budget: no unconditionally-true guard is emitted for an interned field');
  const { stringifyMoney, stringifyPayment } = instantiate(source);
  const moneyValue = { currency: 'USD', value: '10.00' };
  assert.equal(stringifyMoney(moneyValue as never), JSON.stringify(moneyValue));
  const paymentValue = { id: 'p1', amount: moneyValue, note: 'thanks' };
  assert.equal(stringifyPayment(paymentValue as never), JSON.stringify(paymentValue));
});

test('intern preserves type-only nested refs as known-key copies and class refs as construct, and skips identity-only fill', () => {
  const item: ModelTypeDescriptor = {
    kind: 'object',
    properties: { sku: { kind: 'string' } },
    required: ['sku'],
    additionalProperties: false,
  };
  const note: ModelTypeDescriptor = {
    kind: 'object',
    properties: { sku: { kind: 'string' } },
    required: ['sku'],
    additionalProperties: false,
  };
  const flags: ModelTypeDescriptor = {
    kind: 'object',
    properties: {},
    required: [],
    additionalProperties: { kind: 'string' },
  };
  const bag: ModelTypeDescriptor = {
    kind: 'object',
    properties: { lane: { kind: 'string' } },
    required: ['lane'],
    additionalProperties: false,
  };
  const collection: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      typeOnly: { kind: 'array', item: { kind: 'reference', name: 'Item' } },
      classField: { kind: 'reference', name: 'Item', construct: true },
      flags,
      bag,
      notes: { kind: 'array', item: note },
    },
    required: ['typeOnly', 'classField', 'flags', 'bag', 'notes'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  const itemNode = graph.intern(item, 'Item', true);
  graph.intern(collection, 'Collection', true);
  graph.seal();
  const collectionNode = [...graph.nodes.values()].find((node) => node.name === 'Collection');
  assert.equal(collectionNode?.descriptor.kind, 'object');
  if (collectionNode?.descriptor.kind !== 'object') return;
  const typeOnly = collectionNode.descriptor.properties.typeOnly;
  assert.equal(typeOnly?.kind, 'array');
  if (typeOnly?.kind !== 'array') return;
  assert.equal(typeOnly.item.kind, 'reference');
  if (typeOnly.item.kind !== 'reference') return;
  assert.equal(typeOnly.item.construct, undefined);
  const classField = collectionNode.descriptor.properties.classField;
  assert.equal(classField?.kind, 'reference');
  if (classField?.kind !== 'reference') return;
  assert.equal(classField.construct, true);
  const source = emitRuntime(graph);
  class ItemStub {
    public constructor(values: object = {}) {
      Object.assign(this, values);
    }
  }
  serde.registerIModelClass(itemNode.codecId, ItemStub);
  const { fromWireFormatCollection } = instantiateRuntime(source);
  const wireFlags = { colorFlag: 'blue', sizeFlag: 'large' };
  const wire = {
    typeOnly: [{ sku: 'a', extra: 'drop-me' }],
    classField: { sku: 'b', extra: 'keep-me' },
    flags: wireFlags,
    bag: { lane: 'north', extra: 'drop-me' },
    notes: [{ sku: 'n1', extra: 'drop-me' }],
  };
  const result = fromWireFormatCollection(wire, { validate: false }) as {
    typeOnly: unknown[];
    classField: unknown;
    flags: unknown;
    bag: unknown;
    notes: unknown[];
  };
  assert.deepEqual(result.typeOnly, [{ sku: 'a' }], 'a type-only nested ref copies only its known keys');
  assert.ok(result.classField instanceof ItemStub, 'a construct:true reference is constructed via the registered IModel class instead of an identity-only fill');
  assert.deepEqual(result.flags, wireFlags, 'an additionalProperties nested object passes every key through instead of only known ones');
  assert.deepEqual(result.bag, { lane: 'north' }, 'a closed nested object copies only its known keys, dropping the extra one');
  assert.deepEqual(result.notes, [{ sku: 'n1' }], 'array items of a closed nested object copy only their known keys');
});

test('construct skips identity-only fill and reuses extras-allowed identity nested objects', () => {
  const item: ModelTypeDescriptor = {
    kind: 'object',
    properties: { sku: { kind: 'string' } },
    required: ['sku'],
    additionalProperties: false,
  };
  const note: ModelTypeDescriptor = {
    kind: 'object',
    properties: { sku: { kind: 'string' } },
    required: ['sku'],
    additionalProperties: false,
  };
  const flags: ModelTypeDescriptor = {
    kind: 'object',
    properties: {},
    required: [],
    additionalProperties: { kind: 'string' },
  };
  const bag: ModelTypeDescriptor = {
    kind: 'object',
    properties: { lane: { kind: 'string' } },
    required: ['lane'],
    additionalProperties: false,
  };
  const root: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      flags,
      bag,
      notes: { kind: 'array', item: note },
      item: { kind: 'reference', name: 'Item', construct: true },
    },
    required: ['flags', 'bag', 'notes', 'item'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  const itemNode = graph.intern(item, 'Item', true);
  graph.intern(root, 'Root');
  graph.seal();
  const source = emitRuntime(graph);
  class ItemStub {
    public constructor(values: object = {}) {
      Object.assign(this, values);
    }
  }
  serde.registerIModelClass(itemNode.codecId, ItemStub);
  const { fromWireFormatRoot } = instantiateRuntime(source);
  const wireFlags = { colorFlag: 'blue', sizeFlag: 'large' };
  const wireBag = { lane: 'north', extra: 'drop-me' };
  const wire = {
    flags: wireFlags,
    bag: wireBag,
    notes: [{ sku: 'n1', extra: 'drop-me' }],
    item: { sku: 'i1' },
  };
  const result = fromWireFormatRoot(wire, { validate: false }) as {
    flags: unknown;
    bag: unknown;
    notes: unknown[];
    item: unknown;
  };
  assert.deepEqual(result.flags, wireFlags, 'an additionalProperties nested object passes every key through instead of only known ones');
  assert.deepEqual(result.bag, { lane: 'north' }, 'a closed nested object copies only its known keys, dropping the extra one');
  assert.deepEqual(result.notes, [{ sku: 'n1' }], 'array items of a closed nested object copy only their known keys');
  assert.ok(result.item instanceof ItemStub, 'a construct:true reference is constructed via the registered class instead of an identity-only fill');
});

test('TSerde intern emits a second schema only when wire and model intern keys differ', () => {
  const converted: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      permissions: { kind: 'number', serde: { id: 'perm', wire: { kind: 'string' } } },
    },
    required: ['permissions'],
    additionalProperties: false,
  };
  const identity: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      name: { kind: 'string', serde: { id: 'id', wire: { kind: 'string' } } },
    },
    required: ['name'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern(converted, 'PermissionInput');
  graph.intern(identity, 'NameInput');
  graph.seal();
  const permission = [...graph.nodes.values()].find((node) => node.name === 'PermissionInput');
  const name = [...graph.nodes.values()].find((node) => node.name === 'NameInput');
  assert.equal(permission?.sameSchema, false);
  assert.equal(name?.sameSchema, true);
  const source = emitRuntime(graph);
  assert.match(source, /PermissionInput_[0-9a-f]{8}#wire/, 'a second schema is registered for PermissionInput because its wire and model intern keys differ');
  assert.doesNotMatch(source, /NameInput_[0-9a-f]{8}#wire/, 'no second schema is registered for NameInput because its wire and model intern keys are identical');
  // The only way to observe that stringify composes through its own wire-plane function
  // instead of degenerating to a naive JSON.stringify(wire): both produce the same bytes
  // for this fixture, so a round trip alone cannot catch a regression to the fallback.
  assert.match(source, /return stringify\w+Wire\(wire as never/, 'the codec composes through its own wire stringify function instead of a naive JSON.stringify(wire)');
  assert.doesNotMatch(source, /return JSON\.stringify\(wire\)/, 'the codec never falls back to JSON.stringify(wire) directly');
  const { parsePermissionInput, stringifyPermissionInput, parseNameInput, stringifyNameInput } = instantiateRuntime(source);
  const permissionWire = { permissions: '5' };
  const decodedPermission = parsePermissionInput(JSON.stringify(permissionWire), { validate: false }) as Record<string, unknown>;
  assert.equal(stringifyPermissionInput(decodedPermission as never, { validate: false }), JSON.stringify(permissionWire), 'PermissionInput round-trips through its own wire stringify function');
  const nameWire = { name: 'ann' };
  const decodedName = parseNameInput(JSON.stringify(nameWire), { validate: false }) as Record<string, unknown>;
  assert.equal(stringifyNameInput(decodedName as never, { validate: false }), JSON.stringify(nameWire), 'NameInput round-trips even though model and wire share one schema');
});

test('IObject and IModel with the same TSerde fields intern as separate stringify nodes', () => {
  const fields: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      permissions: { kind: 'number', serde: { id: 'perm', wire: { kind: 'string' } } },
    },
    required: ['permissions'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern({ ...fields, properties: { ...fields.properties } }, 'PermissionInput');
  graph.intern({
    kind: 'object',
    properties: {
      permissions: { kind: 'number', serde: { id: 'perm', wire: { kind: 'string' } } },
    },
    required: ['permissions'],
    additionalProperties: false,
  }, 'Permission', true);
  graph.seal();
  const objectNode = [...graph.nodes.values()].find((node) => node.name === 'PermissionInput');
  const modelNode = [...graph.nodes.values()].find((node) => node.name === 'Permission');
  assert.ok(objectNode);
  assert.ok(modelNode);
  assert.equal(objectNode?.emitClass, false);
  assert.equal(modelNode?.emitClass, true);
  assert.equal(objectNode?.sameSchema, false);
  const modelJsonSchema = objectNode?.modelJsonSchema;
  const wireJsonSchema = objectNode?.jsonSchema;
  if (typeof modelJsonSchema !== 'object' || !modelJsonSchema || typeof wireJsonSchema !== 'object' || !wireJsonSchema) {
    throw new TypeError('expected object json schemas');
  }
  const modelProperties = modelJsonSchema as { properties?: Record<string, { type?: string }> };
  const wireProperties = wireJsonSchema as { properties?: Record<string, { type?: string }> };
  assert.equal(modelProperties.properties?.permissions?.type, 'number', 'the model plane keeps the TSerde field as a number');
  assert.equal(wireProperties.properties?.permissions?.type, 'string', 'the wire plane keeps the TSerde field as its wire type');
  assert.equal(Object.hasOwn(modelJsonSchema, '$ref'), false, 'the object node schema does not $ref the unrelated IModel node');
  const source = emitRuntime(graph);
  // One model-only and one wire-only residual schema per node (PermissionInput, Permission).
  const plan = buildCodecValidationPlan([graph], [], {}, true);
  assert.equal(plan.ownSchemas.filter((id) => /#(?:model|wire)-only$/.test(id)).length, 4, 'one model-only and one wire-only residual schema per node');
  class PermissionModel {
    public constructor(values: object = {}) {
      Object.assign(this, values);
    }
  }
  const { fromWireFormatPermissionInput, stringifyPermissionInput, fromWireFormatPermission, stringifyPermission } = instantiateRuntime(source);
  const permissionInputWire = { permissions: '5', extra: 'drop-me' };
  const decodedInput = fromWireFormatPermissionInput(permissionInputWire, { validate: false }) as Record<string, unknown>;
  assert.deepEqual(decodedInput, { permissions: '5' }, 'fillPermissionInput assigns only the known field');
  assert.equal(stringifyPermissionInput(decodedInput as never, { validate: false }), '{"permissions":"5"}');
  const permissionWire = { permissions: '5' };
  const decodedModel = fromWireFormatPermission(permissionWire, { validate: false, construct: PermissionModel }) as object;
  assert.ok(decodedModel instanceof PermissionModel, 'the IModel node fill supports options.construct like other constructed references');
  assert.equal(stringifyPermission(decodedModel as never, { validate: false }), '{"permissions":"5"}', 'the IModel node has its own stringify function, separate from PermissionInput');
});

test('different Payment contracts intern as distinct hashed codec ids and identical ones as one', () => {
  const billing: ModelTypeDescriptor = {
    kind: 'object',
    properties: { amount: { kind: 'number' } },
    required: ['amount'],
    additionalProperties: false,
  };
  const payout: ModelTypeDescriptor = {
    kind: 'object',
    properties: { destination: { kind: 'string' } },
    required: ['destination'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  const first = graph.intern(billing, 'Payment');
  const second = graph.intern(payout, 'Payment');
  graph.seal();
  assert.equal(first.name, 'Payment');
  assert.equal(second.name, 'Payment');
  assert.notEqual(first.codecId, second.codecId);
  assert.match(first.codecId, /^Payment_[0-9a-f]{8}$/);
  assert.match(second.codecId, /^Payment_[0-9a-f]{8}$/);
  const source = emitRuntime(graph);
  assert.match(source, new RegExp(`createObjectCodec\\("${first.codecId}"`));
  assert.match(source, new RegExp(`createObjectCodec\\("${second.codecId}"`));

  const identical = createSchemaGraph();
  const copyA = identical.intern({ ...billing, properties: { ...billing.properties } }, 'Payment');
  const copyB = identical.intern({
    kind: 'object',
    properties: { amount: { kind: 'number' } },
    required: ['amount'],
    additionalProperties: false,
  }, 'Payment');
  assert.equal(copyA.codecId, copyB.codecId);
  assert.equal(identical.nodes.size, 1);
});

test('IObject references and OpenAPI generated-model refs share a codec shape', () => {
  const viaRef: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      money: { kind: 'reference', name: 'Money', projection: true },
      note: { kind: 'string', constraints: [{ kind: 'maxLength', value: 140 }] },
    },
    required: ['note', 'money'],
    additionalProperties: false,
  };
  const viaGenerated: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      money: { kind: 'generated-model', id: 'Money' },
      note: { kind: 'string', constraints: [{ kind: 'maxLength', value: 140 }] },
    },
    required: ['money', 'note'],
    additionalProperties: false,
  };
  assert.equal(codecPublicId('Payment', viaRef), codecPublicId('Payment', viaGenerated));
  assert.match(codecPublicId('Payment', viaRef), /^Payment_[0-9a-f]{8}$/);
});

test('a model that reaches a codec with a wire schema has a wire schema of its own', () => {
  // protects: bug T-161 a reference to a codec of another module reads the same in both planes
  const holder = (field: ModelTypeDescriptor): ModelTypeDescriptor => ({
    kind: 'object',
    properties: { child: field, note: { kind: 'string' } },
    required: ['child', 'note'],
    additionalProperties: false,
  });
  const sealed = (descriptor: ModelTypeDescriptor, externalWireIds?: ReadonlySet<string>) => {
    const graph = createSchemaGraph({ Holder: holder(descriptor) }, {
      codecIds: new Map([['Money', 'Money_00000001']]),
      ...(externalWireIds ? { externalWireIds } : {}),
    });
    graph.seal();
    return graph.nodeFor(graph.nodes.get('Holder')!.descriptor, 'Holder')!.sameSchema;
  };
  const sibling: ModelTypeDescriptor = { kind: 'reference', name: 'Money' };
  const external: ModelTypeDescriptor = { kind: 'generated-model', id: 'Vendor.Money' };
  assert.equal(sealed(sibling), true, 'a sibling without a wire schema');
  assert.equal(sealed(sibling, new Set(['Money_00000001'])), false, 'a sibling with a wire schema');
  assert.equal(sealed(sibling, new Set(['Other_00000002'])), true, 'a wire schema of another codec');
  assert.equal(sealed(external), true, 'a manifest model without a wire schema');
  assert.equal(sealed(external, new Set(['Vendor.Money'])), false, 'a manifest model with a wire schema');
  assert.equal(sealed({ kind: 'array', item: sibling }, new Set(['Money_00000001'])), false, 'a codec reached through an array');
});

test('parent Payment codec ids include nested Money contract shape', () => {
  const moneyAmount: ModelTypeDescriptor = {
    kind: 'object',
    properties: { amount: { kind: 'string' } },
    required: ['amount'],
    additionalProperties: false,
  };
  const moneyFee: ModelTypeDescriptor = {
    kind: 'object',
    properties: { amount: { kind: 'string' }, fee: { kind: 'string' } },
    required: ['amount', 'fee'],
    additionalProperties: false,
  };
  const paymentOf = (moneyName: string): ModelTypeDescriptor => ({
    kind: 'object',
    properties: {
      id: { kind: 'string' },
      money: { kind: 'reference', name: moneyName },
    },
    required: ['id', 'money'],
    additionalProperties: false,
  });
  const different = createSchemaGraph();
  different.intern(moneyAmount, 'Money');
  const billing = different.intern(paymentOf('Money'), 'Payment');
  const payoutGraph = createSchemaGraph();
  payoutGraph.intern(moneyFee, 'Money');
  const payout = payoutGraph.intern(paymentOf('Money'), 'Payment');
  assert.notEqual(billing.codecId, payout.codecId);
  assert.match(billing.codecId, /^Payment_[0-9a-f]{8}$/);
  assert.match(payout.codecId, /^Payment_[0-9a-f]{8}$/);

  const left = createSchemaGraph();
  left.intern(moneyAmount, 'Money');
  const first = left.intern(paymentOf('Money'), 'Payment');
  const right = createSchemaGraph();
  right.intern(moneyAmount, 'Money');
  const second = right.intern(paymentOf('Money'), 'Payment');
  assert.equal(first.codecId, second.codecId);
});

test('codec declaration table maps source#Name to hashed ids and rejects conflicting rows', () => {
  const billing = emitCodecDeclarationTable([
    { source: 'src/billing/payment.model.ts', name: 'Payment', codecId: 'Payment_aaaaaaaa' },
    { source: 'src/payout/payment.model.ts', name: 'TPayment', codecId: 'Payment_bbbbbbbb' },
  ]);
  assert.equal(JSON.parse(billing).version, 1, 'the table is the version 1 codec key file');
  assert.match(billing, /"src\/billing\/payment\.model\.ts#Payment": "Payment_aaaaaaaa"/);
  assert.match(billing, /"src\/payout\/payment\.model\.ts#TPayment": "Payment_bbbbbbbb"/);
  assert.throws(
    () => emitCodecDeclarationTable([
      { source: 'src/payment.model.ts', name: 'Payment', codecId: 'Payment_aaaaaaaa' },
      { source: 'src/payment.model.ts', name: 'Payment', codecId: 'Payment_bbbbbbbb' },
    ]),
    /maps to both/,
  );
  const exact = emitCodecDeclarationTable([
    { source: 'src/payment.model.ts', name: 'Payment', codecId: 'Payment_aaaaaaaa', classNames: ['PaymentModel'] },
    { source: 'src/payment.model.ts', name: 'TPayment', codecId: 'TPayment_bbbbbbbb', classNames: ['Payment2', 'Payment3'] },
  ]);
  for (const [name, id] of [['Payment', 'Payment_aaaaaaaa'], ['PaymentModel', 'Payment_aaaaaaaa'], ['TPayment', 'TPayment_bbbbbbbb'], ['Payment2', 'TPayment_bbbbbbbb'], ['Payment3', 'TPayment_bbbbbbbb']]) {
    assert.match(exact, new RegExp(`"src/payment\\.model\\.ts#${name}": "${id}"`), `${name} keeps its own exact entry`);
  }
});

test('codec declaration table lists the model and its class when the class name differs', () => {
  const table = emitCodecDeclarationTable([
    { source: 'src/order.model.ts', name: 'TOrder', codecId: 'TOrder_aaaaaaaa', classNames: ['PurchaseOrder', 'RushOrder'] },
    { source: 'src/order.model.ts', name: 'TInvoice', codecId: 'TInvoice_bbbbbbbb' },
  ]);
  assert.match(table, /"src\/order\.model\.ts#TOrder": "TOrder_aaaaaaaa"/);
  assert.match(table, /"src\/order\.model\.ts#PurchaseOrder": "TOrder_aaaaaaaa"/);
  assert.match(table, /"src\/order\.model\.ts#TInvoice": "TInvoice_bbbbbbbb"/);
  assert.match(table, /"src\/order\.model\.ts#RushOrder": "TOrder_aaaaaaaa"/);
  assert.equal(table.match(/TOrder_aaaaaaaa/g)?.length, 3);
});

test('nested IModel refs keep construct on the hashed codec id', () => {
  const child: ModelTypeDescriptor = {
    kind: 'object',
    properties: { id: { kind: 'string' } },
    required: ['id'],
    additionalProperties: false,
  };
  const parent: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      child: { kind: 'reference', name: 'Child', construct: true },
    },
    required: ['child'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  const childNode = graph.intern(child, 'Child', true);
  graph.intern(parent, 'Parent', true);
  graph.seal();
  const sealedParent = [...graph.nodes.values()].find((node) => node.name === 'Parent');
  const nested = sealedParent?.descriptor.kind === 'object'
    ? sealedParent.descriptor.properties.child
    : undefined;
  assert.equal(nested?.kind, 'reference');
  assert.equal(nested && 'name' in nested ? nested.name : undefined, childNode.codecId);
  assert.equal(nested && 'construct' in nested ? nested.construct : undefined, true);
  const source = emitRuntime(graph);
  class ChildStub {
    public constructor(values: object = {}) {
      Object.assign(this, values);
    }
  }
  serde.registerIModelClass(childNode.codecId, ChildStub);
  const { fromWireFormatParent } = instantiateRuntime(source);
  const result = fromWireFormatParent({ child: { id: 'x' } }, { validate: false }) as { child: unknown };
  assert.ok(result.child instanceof ChildStub, 'the nested reference constructs via the class registered under the hashed codec id');
});

test('named refs inside constraints rewrite to hashed codec ids', () => {
  const child: ModelTypeDescriptor = {
    kind: 'object',
    properties: { id: { kind: 'string' } },
    required: ['id'],
    additionalProperties: false,
  };
  const parent: ModelTypeDescriptor = {
    kind: 'object',
    properties: { skip: { kind: 'boolean' } },
    required: [],
    additionalProperties: false,
    constraints: [{ kind: 'not', schema: { kind: 'reference', name: 'Child' } }],
  };
  const graph = createSchemaGraph();
  const childNode = graph.intern(child, 'Child', true);
  graph.intern(parent, 'Parent');
  graph.seal();
  const sealedParent = [...graph.nodes.values()].find((node) => node.name === 'Parent');
  const modelSchema = sealedParent?.modelJsonSchema as { not?: { $ref?: string } } | undefined;
  assert.equal(modelSchema?.not?.$ref, `#/$defs/${childNode.codecId}`, 'the constraint ref rewrites to the hashed codec id instead of the literal "Child" name');
});

test('wire schema drops model-only Not predicates and IObject assert checks the model shape', async () => {
  const descriptor: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      neg: {
        kind: 'unknown',
        constraints: [{
          kind: 'not',
          schema: { kind: 'number', validations: ['positive'] },
        }],
      },
    },
    required: [],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern(descriptor, 'A');
  graph.seal();
  const node = [...graph.nodes.values()].find((item) => item.name === 'A');
  assert.equal(node?.sameSchema, false);
  const modelNegSchema = (node?.modelJsonSchema as { properties?: Record<string, { not?: unknown }> } | undefined)?.properties?.neg;
  const wireNegSchema = (node?.jsonSchema as { properties?: Record<string, { not?: unknown }> } | undefined)?.properties?.neg;
  assert.notEqual(modelNegSchema?.not, undefined, 'the model plane keeps the Not predicate');
  assert.equal(wireNegSchema?.not, undefined, 'the wire plane drops the model-only Not predicate');
  // The "positive" function of the model-only Not predicate is supplied by the surrounding generator.
  const validators = await compileValidationPlanBinding(buildCodecValidationPlan([graph], [], {}, true), {
    validations: { positive: { importPath: './rules.mjs', exportName: 'positive' } },
    modules: { 'rules.mjs': "export const positive = value => typeof value === 'number' && value > 0;" },
  });
  const source = emitCodecRuntime(graph, { validatorName: validators.validatorName });
  const { assertA, fromWireFormatA, parseA } = instantiateRuntime(source, validators.scope);
  assert.throws(
    () => assertA({ neg: 5 }),
    (error: unknown) => error instanceof LibError
      && (error.issues as ReadonlyArray<{ representation: string }>)[0]?.representation === 'model',
    'the model-plane assert reports issues in the model representation, which is where the dropped Not predicate still applies',
  );
  // additionalProperties: false makes an unknown wire key fail wire-plane validation,
  // which is where the dropped Not predicate does not apply.
  assert.throws(
    () => fromWireFormatA({ extra: 1 }, { validate: true }),
    (error: unknown) => error instanceof LibError
      && (error.issues as ReadonlyArray<{ representation: string }>)[0]?.representation === 'wire',
    'the wire-plane assert reports issues in the wire representation',
  );
  assert.throws(
    () => parseA('{"extra":1}'),
    (error: unknown) => error instanceof LibError
      && (error.issues as ReadonlyArray<{ representation: string }>)[0]?.representation === 'wire',
    'parse validates against the wire plane too',
  );
});

test('fill assigns known fields, keeps __proto__ defineProperty, and nested models skip clone', () => {
  const graph = createSchemaGraph();
  const properties = Object.create(null) as Record<string, ModelTypeDescriptor>;
  properties.money = { kind: 'generated-model', id: 'Money' };
  properties.note = { kind: 'string' };
  properties['__proto__'] = { kind: 'string' };
  graph.intern({
    kind: 'object',
    properties,
    required: ['money', 'note', '__proto__'],
    additionalProperties: false,
  }, 'Checkout', true);
  graph.seal();
  const source = emitCodecRuntime(graph, {
    validatorName: (id) => `validate_${id.replace(/[^\w$]/g, '_')}`,
    nestedGenerated: (id) => id === 'Money' ? 'MoneyModel' : id,
  });
  // The fill reads each field once by the JSON view, then copies a present one.
  assert.match(source, /if \(copyIdentity\) \{\n    if \(__golemPresent\d+ !== undefined\) \{\n      out\["note"\] = __golemPresent\d+;/, 'budget: defineModelProperty is heavier than a plain assignment, so an ordinary field is copied with a direct assignment');
  class MoneyModel {
    public constructor(values: object = {}) {
      Object.assign(this, values);
    }
  }
  serde.createObjectCodec('Money', {
    stringify: (value) => JSON.stringify(value),
    parse: (text) => JSON.parse(text) as never,
    validate: (value: unknown): value is never => true,
    assert: (value) => value as never,
    toWireFormat: (value) => ({ ...(value as object) }),
    fromWireFormat: (wire) => new MoneyModel(wire as object) as never,
    schema: { $id: 'Money', type: 'object', properties: { amount: { type: 'number' } } },
    schemaRefsResolved: true,
  });
  const { fromWireFormatCheckout, parseCheckout } = instantiateRuntime(source, {
    MoneyModel,
    decodeGeneratedModelTrusted: (constructor: new (values?: object) => object, value: object) =>
      value instanceof constructor ? value : new constructor(value),
  });
  // JSON.parse (unlike an object literal) makes "__proto__" a genuine own property,
  // which is the actual shape a decoded wire payload has. The value must be an object:
  // assigning an object (unlike a string) through a plain `out.__proto__ = value` actually
  // repoints the prototype, so only an object value can catch a regression away from
  // defineModelProperty.
  const wire = JSON.parse('{"money":{"amount":5},"note":"hi","__proto__":{"polluted":true}}') as Record<string, unknown>;
  const result = fromWireFormatCheckout(wire, { validate: false }) as Record<string, unknown>;
  assert.ok(result.money instanceof MoneyModel, 'a generated-model field decodes through decodeGeneratedModelTrusted');
  assert.equal(result.note, 'hi', 'a plain field keeps its value');
  assert.equal(Object.getPrototypeOf(result), Object.prototype, 'copying "__proto__" through defineModelProperty does not repoint the result\'s own prototype');
  assert.equal(Object.prototype.hasOwnProperty.call(result, '__proto__'), true, 'the "__proto__" key is defined as the result\'s own property');
  assert.deepEqual(result['__proto__'], { polluted: true }, 'the "__proto__" key keeps its wire value');
  const parsed = parseCheckout(JSON.stringify(wire), { validate: false }) as Record<string, unknown>;
  assert.equal(parsed.note, 'hi', 'parse round-trips through the same fill as fromWireFormat');
});
