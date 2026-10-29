import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { identifier } from '@exprtlabs/golem/internal/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';
import { instantiateRuntime, emitCodecRuntimeText } from './emitted-runtime.js';
import { compileValidationPlanBinding } from './support/compiled-validators.js';

/** A parent that nests a model with a date, so the wire differs from the model and validation is on. */
function paymentGraph(): ReturnType<typeof createSchemaGraph> {
  const money: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      currency: { kind: 'string' },
      at: { kind: 'date' },
      tags: { kind: 'array', item: { kind: 'string' } },
    },
    required: ['currency', 'at', 'tags'],
    additionalProperties: false,
  };
  const payment: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      id: { kind: 'string' },
      amount: { kind: 'reference', name: 'Money' },
      note: { kind: 'string' },
      list: { kind: 'array', item: { kind: 'array', item: { kind: 'string' } } },
    },
    required: ['id', 'amount', 'list'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern(money, 'Money', true);
  graph.intern(payment, 'Payment');
  graph.seal();
  return graph;
}

/** The runtime source of the payment graph; a test that runs it without compiled validators uses the default validator names. */
function paymentRuntimeSource(options: Parameters<typeof emitCodecRuntimeText>[1] = {}): string {
  return emitCodecRuntimeText(paymentGraph(), { validatorName: (id) => identifier(`validate_${id.replace(/[^\w$]/g, '_')}`), ...options });
}

/** The generated validators the payment runtime imports, compiled from the same graph, and the names the runtime source must use. */
function paymentValidators(): ReturnType<typeof compileValidationPlanBinding> {
  return compileValidationPlanBinding(buildCodecValidationPlan([paymentGraph()], [], {}, true));
}

/** The scope validators wrapped to count their calls, by name; the wrapped function keeps its own behavior. */
function countingScope(scope: Readonly<Record<string, unknown>>): { readonly scope: Record<string, unknown>; readonly calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const wrapped = Object.fromEntries(Object.entries(scope).map(([name, validator]) => [name, new Proxy(validator as (...args: unknown[]) => unknown, {
    apply: (target, self, args) => { calls.set(name, (calls.get(name) ?? 0) + 1); return Reflect.apply(target, self, args); },
  })]));
  return { scope: wrapped, calls };
}

/** The payment runtime running on validators that count their calls, by name. */
async function countedPaymentRuntime(): Promise<{ readonly runtime: ReturnType<typeof instantiateRuntime>; readonly calls: Map<string, number> }> {
  const validators = await paymentValidators();
  const counted = countingScope(validators.scope);
  const runtime = instantiateRuntime(paymentRuntimeSource({ validatorName: (id) => identifier(validators.validatorName(id)) }), counted.scope);
  return { runtime, calls: counted.calls };
}

const value = { id: 'p1', amount: { currency: 'USD', at: new Date(0), tags: ['a'] }, list: [['x']] };
const wire = { id: 'p1', amount: { currency: 'USD', at: '1970-01-01T00:00:00.000Z', tags: ['a'] }, list: [['x']] };

test('validate makes one check through the generated validator of the model', async () => {
  // protects: T-363 the emitted validate runs the model's validator once per call
  const { runtime, calls } = await countedPaymentRuntime();
  assert.equal(runtime.validatePayment(value), true);
  assert.deepEqual([...calls.values()], [1], 'one validator ran, once');
  assert.equal(runtime.validatePayment({ ...value, id: 7 }), false);
  assert.deepEqual([...calls.values()], [2]);
});

test('stringify checks the model, builds the wire, checks the wire and writes it', async () => {
  // protects: T-363 the emitted stringify runs the model check and the wire check once each, none for trusted input
  const { runtime, calls } = await countedPaymentRuntime();
  assert.equal(runtime.stringifyPayment(value), JSON.stringify(wire));
  const validated = Object.fromEntries(calls);
  assert.equal(Object.keys(validated).length, 2, 'the model check and the wire-only check each ran');
  assert.deepEqual(Object.values(validated), [1, 1], 'each ran once, for the nested model too');
  calls.clear();
  assert.equal(runtime.stringifyPayment(value, { validate: false }), JSON.stringify(wire));
  assert.equal(calls.size, 0, 'trusted input runs no validator');
  assert.throws(() => runtime.stringifyPayment({ ...value, id: 7 }), /validation/i);
});

test('identity arrays are copied, so the decoded and encoded values share no array with their input', () => {
  const runtime = instantiateRuntime(paymentRuntimeSource());
  const decoded = runtime.fromWireFormatPayment(wire, { validate: false }) as { list: string[][]; amount: { tags: string[] } };
  assert.deepEqual(decoded.list, [['x']]);
  assert.notEqual(decoded.list, wire.list);
  assert.notEqual(decoded.list[0], wire.list[0]);
  assert.notEqual(decoded.amount.tags, wire.amount.tags);
  const encoded = runtime.toWireFormatPayment(decoded, { validate: false }) as { amount: { tags: string[] } };
  assert.deepEqual(encoded.amount.tags, ['a']);
  assert.notEqual(encoded.amount.tags, decoded.amount.tags);
});

test('a nested call to a model of the same module runs unvalidated inside the one outer check', async () => {
  // protects: T-363 a nested model call inside one outer check runs no validator of its own
  const { runtime, calls } = await countedPaymentRuntime();
  // The trusted path reaches the nested Money through its own core, which neither validates nor takes options.
  assert.doesNotThrow(() => runtime.stringifyPayment({ ...value, id: 7 }, { validate: false }));
  assert.deepEqual(runtime.toWireFormatPayment({ ...value, id: 7 }, { validate: false }), { ...wire, id: 7 });
  assert.equal(calls.size, 0);
  assert.equal(runtime.stringifyPayment(value), JSON.stringify(wire));
  assert.equal(calls.size, 2, 'the validated path runs the two Payment checks, none for the nested Money');
});

test('the public toWireFormat validates the model first, builds the wire, and skips both checks for trusted input', async () => {
  const validators = await paymentValidators();
  const runtime = instantiateRuntime(paymentRuntimeSource({ validatorName: (id) => identifier(validators.validatorName(id)) }), validators.scope);
  assert.deepEqual(runtime.toWireFormatPayment(value), wire);
  assert.deepEqual(runtime.toWireFormatPayment(value, { validate: false }), wire);
  assert.throws(() => runtime.toWireFormatPayment({ ...value, id: 7 }), /validation/i, 'the model check runs first');
  assert.deepEqual(runtime.toWireFormatPayment({ ...value, id: 7 }, { validate: false }), { ...wire, id: 7 }, 'trusted input skips it');
});

test('a nested trusted call to a model of another module shares one frozen options constant', () => {
  const owner: ModelTypeDescriptor = {
    kind: 'object',
    properties: { pet: { kind: 'generated-model', id: 'Pet' }, pets: { kind: 'array', item: { kind: 'generated-model', id: 'Pet' } } },
    required: ['pet', 'pets'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern({ kind: 'generated-model', id: 'Pet' }, 'Pet');
  graph.intern(owner, 'Owner');
  graph.seal();
  const source = emitCodecRuntimeText(graph, { validationEnabled: false, nestedGenerated: (id) => identifier(`${id}Model`) });
  const received: unknown[] = [];
  const pet = { stringify: (_value: unknown, options: unknown) => { received.push(options); return '"pet"'; }, toWireFormat: (_value: unknown, options: unknown) => { received.push(options); return 'pet'; } };
  const runtime = instantiateRuntime(source, { requireObjectCodec: () => pet });
  assert.equal(runtime.stringifyOwner({ pet: {}, pets: [{}, {}] }), '{"pet":"pet","pets":["pet","pet"]}');
  assert.deepEqual(runtime.toWireFormatOwner({ pet: {}, pets: [{}] }), { pet: 'pet', pets: ['pet'] });
  assert.equal(received.length, 5);
  assert.deepEqual(received[0], { validate: false });
  assert.ok(Object.isFrozen(received[0]));
  assert.ok(received.every((options) => options === received[0]), 'every nested call passes the same constant');
});

test('a codec registers the query fields that a query string decodes, and no JSON Schema', () => {
  // protects: T-640 R-58 a registered codec holds no JSON Schema; Nest query decoding reads queryFields
  const filter: ModelTypeDescriptor = {
    kind: 'object',
    properties: {
      name: { kind: 'string' },
      limit: { kind: 'number' },
      active: { kind: 'boolean' },
      ids: { kind: 'array', item: { kind: 'number', constraints: [{ kind: 'integer' }] } },
    },
    required: [],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern(filter, 'Filter');
  graph.seal();
  const registered: Record<string, unknown>[] = [];
  const createObjectCodec = (_id: string, codec: Record<string, unknown>): void => { registered.push(codec); };
  instantiateRuntime(emitCodecRuntimeText(graph, { validationEnabled: false }), { createObjectCodec });
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0]?.queryFields, {
    active: { types: ['boolean'] },
    ids: { types: [], item: { types: ['number', 'integer'] } },
    limit: { types: ['number'] },
  });
  assert.deepEqual(Object.keys(registered[0] ?? {}).filter((key) => /schema/i.test(key)), []);
});
