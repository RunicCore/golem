import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph } from '@exprtlabs/golem/schema-graph';
import { emitCodecRuntime, emitModelFromInit, emitModelFromJSON, emitModelToJSON } from '@exprtlabs/golem/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { instantiateRuntime } from './emitted-runtime.js';

/** A parent that nests a model with a date, so the wire differs from the model and validation is on. */
function paymentRuntimeSource(options: Parameters<typeof emitCodecRuntime>[1] = {}): string {
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
  return emitCodecRuntime(graph, options);
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

test('validate reads the chosen fail-fast validator once', () => {
  const body = functionBody(paymentRuntimeSource(), 'validatePayment');
  assert.equal(occurrences(body, 'failFast ?'), 2, 'one choice between validators and one between context modes');
  assert.match(body, /const validator = failFast \? validatePaymentFast : validatePaymentAll;/);
  assert.doesNotMatch(body, /validatePaymentFast\(value\)|validatePaymentFast\.errors/);
});

test('stringify checks the model, builds the wire, checks the wire and writes it in one guarded block', () => {
  const source = paymentRuntimeSource();
  const body = functionBody(source, 'stringifyPayment');
  assert.equal(occurrences(body, 'if (validates)'), 1, 'one guard');
  const order = ['assertPayment(value, options)', 'const wire =', '__golemAssertWireOnly_Payment(wire, options)', 'stringifyPaymentWire(wire']
    .map((step) => body.indexOf(step));
  assert.ok(order.every((index) => index >= 0), `every step is emitted: ${order.join(', ')}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'model check, wire build, wire-only check, wire stringify');
  assert.ok(body.indexOf('stringifyPaymentCore(') > body.indexOf('stringifyPaymentWire('), 'the unvalidated path follows the guarded block');

  const runtime = instantiateRuntime(source);
  const value = { id: 'p1', amount: { currency: 'USD', at: new Date(0), tags: ['a'] }, list: [['x']] };
  const wire = { id: 'p1', amount: { currency: 'USD', at: '1970-01-01T00:00:00.000Z', tags: ['a'] }, list: [['x']] };
  assert.equal(runtime.stringifyPayment(value), JSON.stringify(wire));
  assert.equal(runtime.stringifyPayment(value, { validate: false }), JSON.stringify(wire));
  assert.throws(() => runtime.stringifyPayment({ ...value, id: 7 }), /validation/i);
});

test('identity arrays are copied with slice, not a map callback that returns its item', () => {
  const source = paymentRuntimeSource();
  assert.doesNotMatch(source, /\.map\(\(item\) => item\)/);
  assert.match(functionBody(source, 'fillPayment'), /\(wire\["list"\] as readonly unknown\[\]\)\.map\(\(item\) => Array\.isArray\(item\) \? \(item as readonly unknown\[\]\)\.slice\(\) : item\)/);
  assert.match(functionBody(source, 'fillMoney'), /\(wire\["tags"\] as readonly unknown\[\]\)\.slice\(\)/);
  assert.match(functionBody(source, 'toWireFormatMoney'), /\(__golemField0 as readonly unknown\[\]\)\.slice\(\)/);

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
