import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { emitCodecRuntime, emitModelFromInit, emitModelFromJSON, emitModelToJSON } from '@exprtlabs/golem/internal/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';
import { instantiateRuntime } from './emitted-runtime.js';
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
  graph.intern(payment, 'Payment', true);
  graph.seal();
  return graph;
}

/** The runtime source; a test that only reads the text names each validator after its root. */
function paymentRuntimeSource(options: Parameters<typeof emitCodecRuntime>[1] = {}): string {
  return emitCodecRuntime(paymentGraph(), { validatorName: (id) => `validate_${id.replace(/[^\w$]/g, '_')}`, ...options });
}

/** The generated validators the payment runtime imports, compiled from the same graph, and the names the runtime source must use. */
function paymentValidators(): ReturnType<typeof compileValidationPlanBinding> {
  return compileValidationPlanBinding(buildCodecValidationPlan([paymentGraph()], [], {}, true));
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `generated function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `end of generated function ${name}`);
  return source.slice(start, end);
}

function occurrences(text: string, pattern: string): number {
  return text.split(pattern).length - 1;
}

test('validate makes one check through the generated validator of the model', () => {
  const body = functionBody(paymentRuntimeSource(), 'validatePayment');
  assert.equal(occurrences(body, 'isValidModelValue('), 1, 'one check');
  assert.match(body, /return isValidModelValue\(value, options, validate_Payment_[0-9a-f]{8}, "Payment_[0-9a-f]{8}"\);/);
});

test('stringify checks the model, builds the wire, checks the wire and writes it in one guarded block', async () => {
  const validators = await paymentValidators();
  const source = paymentRuntimeSource({ validatorName: validators.validatorName });
  const body = functionBody(source, 'stringifyPayment');
  assert.equal(occurrences(body, 'if (validates)'), 1, 'one guard');
  const order = ['assertPayment(value, options)', 'const wire =', '__golemAssertWireOnly_Payment(wire, options)', 'stringifyPaymentWire(wire']
    .map((step) => body.indexOf(step));
  assert.ok(order.every((index) => index >= 0), `every step is emitted: ${order.join(', ')}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'model check, wire build, wire-only check, wire stringify');
  assert.ok(body.indexOf('stringifyPaymentCore(') > body.indexOf('stringifyPaymentWire('), 'the unvalidated path follows the guarded block');

  const runtime = instantiateRuntime(source, validators.scope);
  const value = { id: 'p1', amount: { currency: 'USD', at: new Date(0), tags: ['a'] }, list: [['x']] };
  const wire = { id: 'p1', amount: { currency: 'USD', at: '1970-01-01T00:00:00.000Z', tags: ['a'] }, list: [['x']] };
  assert.equal(runtime.stringifyPayment(value), JSON.stringify(wire));
  assert.equal(runtime.stringifyPayment(value, { validate: false }), JSON.stringify(wire));
  assert.throws(() => runtime.stringifyPayment({ ...value, id: 7 }), /validation/i);
});

test('identity arrays are copied with slice, not a map callback that returns its item', () => {
  const source = paymentRuntimeSource();
  assert.doesNotMatch(source, /\.map\(\(item\) => item\)/);
  assert.match(functionBody(source, 'fillPayment'), /\(__golemWire\d+ as readonly unknown\[\]\)\.map\(\(item\) => Array\.isArray\(item\) \? \(item as readonly unknown\[\]\)\.slice\(\) : item\)/);
  assert.match(functionBody(source, 'fillMoney'), /\(__golemWire\d+ as readonly unknown\[\]\)\.slice\(\)/);
  assert.match(functionBody(source, 'toWireFormatMoneyCore'), /\(__golemField0 as readonly unknown\[\]\)\.slice\(\)/);

  const runtime = instantiateRuntime(source);
  const wire = { id: 'p1', amount: { currency: 'USD', at: '1970-01-01T00:00:00.000Z', tags: ['a'] }, list: [['x']] };
  const decoded = runtime.fromWireFormatPayment(wire, { validate: false }) as { list: string[][]; amount: { tags: string[] } };
  assert.deepEqual(decoded.list, [['x']]);
  assert.notEqual(decoded.list, wire.list);
  assert.notEqual(decoded.list[0], wire.list[0]);
  assert.notEqual(decoded.amount.tags, wire.amount.tags);
  const encoded = runtime.toWireFormatPayment(decoded, { validate: false }) as { amount: { tags: string[] } };
  assert.deepEqual(encoded.amount.tags, ['a']);
  assert.notEqual(encoded.amount.tags, decoded.amount.tags);
});

test('model initializers, fromJSON and toJSON copy an unchanged array with slice', () => {
  const strings: ModelTypeDescriptor = { kind: 'array', item: { kind: 'string' } };
  const unusedModel = (id: string): never => { throw new Error(`No model expected: ${id}`); };
  const copied = 'Array.isArray(values) ? (values as readonly unknown[]).slice() : values';
  assert.equal(emitModelFromInit(strings, 'values', unusedModel), copied);
  assert.equal(emitModelFromJSON(strings, 'values', unusedModel), copied);
  assert.equal(emitModelToJSON(strings, 'values', unusedModel), copied);
  const nested: ModelTypeDescriptor = { kind: 'array', item: strings };
  assert.equal(
    emitModelFromInit(nested, 'values', unusedModel),
    'Array.isArray(values) ? (values as readonly unknown[]).map((item) => Array.isArray(item) ? (item as readonly unknown[]).slice() : item) : values',
  );
});

const TRUSTED_LITERAL = '{ validate: false }';

test('a nested trusted call to a model of the same module runs its core and passes no options', () => {
  const source = paymentRuntimeSource();
  assert.equal(occurrences(source, TRUSTED_LITERAL), 0, 'no per-call options literal');
  assert.doesNotMatch(source, /__golemTrusted/, 'no constant when every callee is in this module');
  assert.match(functionBody(source, 'stringifyPaymentCore'), /out \+= stringifyMoneyCore\(__golemValue1 as never\);/);
  assert.match(functionBody(source, 'stringifyPaymentWire'), /stringifyMoneyWire\(value\["amount"\] as never\)/);
  assert.match(functionBody(source, 'stringifyPayment'), /stringifyPaymentWire\(wire as never\);/);
  assert.match(functionBody(source, 'stringifyPayment'), /return stringifyPaymentCore\(value as never\);/);
  assert.match(functionBody(source, 'stringifyPayment'), /toWireFormatMoneyCore\(value\["amount"\] as never\)/);
  assert.match(functionBody(source, 'toWireFormatPaymentCore'), /toWireFormatMoneyCore\(record\["amount"\] as never\)/);
  assert.doesNotMatch(source, /function \w+Core\([^)]*options/, 'a core function takes no options');
  assert.doesNotMatch(source, /function stringify\w+Wire\([^)]*options/, 'a wire stringify takes no options');
});

test('the public toWireFormat validates, builds the wire through its core and checks the wire-only schema last', async () => {
  const validators = await paymentValidators();
  const source = paymentRuntimeSource({ validatorName: validators.validatorName });
  const body = functionBody(source, 'toWireFormatPayment');
  const order = ['assertPayment(value, options)', 'const wire = toWireFormatPaymentCore(value);', '__golemAssertWireOnly_Payment(wire, options)', 'return wire;']
    .map((step) => body.indexOf(step));
  assert.ok(order.every((index) => index >= 0), `every step is emitted: ${order.join(', ')}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.doesNotMatch(body, /\bMoney\b|record\[/, 'the wrapper builds nothing itself');

  const runtime = instantiateRuntime(source, validators.scope);
  const value = { id: 'p1', amount: { currency: 'USD', at: new Date(0), tags: ['a'] }, list: [['x']] };
  const wire = { id: 'p1', amount: { currency: 'USD', at: '1970-01-01T00:00:00.000Z', tags: ['a'] }, list: [['x']] };
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
  graph.intern(owner, 'Owner', true);
  graph.seal();
  const source = emitCodecRuntime(graph, { validationEnabled: false, nestedGenerated: (id) => `${id}Model` });
  assert.equal(occurrences(source, TRUSTED_LITERAL), 1, 'the options literal appears once, in the constant');
  assert.match(source, /^const __golemTrusted = Object\.freeze\(\{ validate: false \}\);\n/);
  assert.match(functionBody(source, 'stringifyOwnerCore'), /stringifyPet\(__golemValue0 as never, __golemTrusted\)/);
  assert.match(functionBody(source, 'stringifyOwnerCore'), /stringifyPet\(item as never, __golemTrusted\)/);
  assert.match(functionBody(source, 'toWireFormatOwnerCore'), /toWireFormatPet\(record\["pet"\] as never, __golemTrusted\)/);
});

test('a codec that does not validate publishes its own schemas, not the plan entries it has none of', () => {
  // The profile is off and no node chose: the plan compiles none of them, so `modelSchemas` holds no entry to read.
  const source = paymentRuntimeSource({ validationEnabled: false, resolvedSchemasExpr: 'modelSchemas' });
  assert.doesNotMatch(source, /modelSchemas\[/);
  assert.match(source, /schema: JSON\.parse\(/);
  assert.doesNotMatch(source, /schemaRefsResolved/);
});
