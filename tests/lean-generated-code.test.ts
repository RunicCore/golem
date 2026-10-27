import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { code, emitModelFromInit, emitModelFromJSON, emitModelToJSON, identifier, render, type StringifySerdeResolver } from '@exprtlabs/golem/internal/emitter';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { buildCodecValidationPlan } from '@exprtlabs/golem/internal/validation-plan';
import * as conversion from '@exprtlabs/golem/conversion';
import * as serde from '@exprtlabs/golem/serde';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { emitCodecRuntimeText, instantiateRuntime } from './emitted-runtime.js';
import { compileValidationPlanBinding } from './support/compiled-validators.js';
import { runModule } from './support/run-module.js';
import { emitGraphStringify } from './support/stringify-graph.js';

// The lean-code guards of the generated codecs. Each counts something the generated code does or holds: the calls on an
// array, the parameters of a function, the validators compiled into scope, the passes over a field. A change that adds
// work and keeps the bytes of the output the same makes a count differ.

const money: ModelTypeDescriptor = {
  kind: 'object',
  properties: { currency: { kind: 'string' }, at: { kind: 'date' }, tags: { kind: 'array', item: { kind: 'string' } } },
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

function paymentGraph(): ReturnType<typeof createSchemaGraph> {
  const graph = createSchemaGraph();
  graph.intern(money, 'Money', true);
  graph.intern(payment, 'Payment');
  graph.seal();
  return graph;
}

const validatorNames = { validatorName: (id: string) => identifier(`validate_${id.replace(/[^\w$]/g, '_')}`) };

test('a generated guard is never a constant condition', () => {
  // protects: F-129 lean generated code: no `if (true)` guard for an interned field
  // A constant condition does nothing when it runs, so no count of calls or bytes can show it; the one pin reads the emitted text.
  const graph = createSchemaGraph();
  graph.intern(money, 'Money');
  graph.intern(payment, 'Payment', true);
  graph.intern({ ...payment, required: ['id', 'amount', 'note', 'list'] }, 'Invoice');
  graph.seal();
  const sources = [render(emitGraphStringify(graph)), emitCodecRuntimeText(paymentGraph(), validatorNames)];
  for (const source of sources) assert.equal([...source.matchAll(/\bif\s*\(\s*true\s*\)/g)].length, 0);
});

/** How often generated code called `slice` and `map` on one array, and how often `map` ran its callback. */
interface ArrayCalls { slice: number; map: number; callbacks: number }

/** A real array whose `slice` and `map` count their calls and then do their work. */
function spyArray<T>(items: readonly T[]): { readonly array: T[]; readonly calls: ArrayCalls } {
  const calls: ArrayCalls = { slice: 0, map: 0, callbacks: 0 };
  const array = [...items];
  Object.defineProperties(array, {
    slice: { value: (...args: [number?, number?]) => { calls.slice += 1; return Array.prototype.slice.apply(array, args); } },
    map: {
      value: (callback: (item: T, index: number) => unknown) => {
        calls.map += 1;
        return Array.prototype.map.call(array, (item: T, index: number) => { calls.callbacks += 1; return callback(item, index); });
      },
    },
  });
  return { array, calls };
}

test('identity arrays are copied with one slice, not mapped through a callback', () => {
  // protects: F-129 lean generated code: an unchanged array is copied with slice, not a map callback
  const runtime = instantiateRuntime(emitCodecRuntimeText(paymentGraph(), validatorNames));
  const tags = spyArray(['a']);
  const inner = spyArray(['x']);
  const outer = spyArray([inner.array]);
  const decoded = runtime.fromWireFormatPayment({ id: 'p1', amount: { currency: 'USD', at: '1970-01-01T00:00:00.000Z', tags: tags.array }, list: outer.array }, { validate: false }) as { amount: { tags: string[] } };
  assert.deepEqual(tags.calls, { slice: 1, map: 0, callbacks: 0 }, 'tags are unchanged: one slice');
  assert.deepEqual(outer.calls, { slice: 0, map: 1, callbacks: 1 }, 'a nested array maps once, one callback for its one item');
  assert.deepEqual(inner.calls, { slice: 1, map: 0, callbacks: 0 }, 'the unchanged inner array is copied by slice');

  const encodedTags = spyArray(decoded.amount.tags);
  runtime.toWireFormatPayment({ id: 'p1', amount: { currency: 'USD', at: new Date(0), tags: encodedTags.array }, list: [['x']] }, { validate: false });
  assert.deepEqual(encodedTags.calls, { slice: 1, map: 0, callbacks: 0 }, 'the encoded tags are copied by one slice');
});

test('model initializers, fromJSON and toJSON copy an unchanged array with one slice and pass a non-array through', () => {
  // protects: F-129 lean generated code: an unchanged array is copied with slice, not a map callback
  const strings: ModelTypeDescriptor = { kind: 'array', item: { kind: 'string' } };
  const unusedModel = (id: string): never => { throw new Error(`No model expected: ${id}`); };
  const run = (expression: string, input: unknown): unknown => runModule(`const result = (${expression});`, { values: input }, { exports: ['result'] }).result;
  for (const emit of [emitModelFromInit, emitModelFromJSON, emitModelToJSON]) {
    const expression = render(emit(strings, identifier('values'), unusedModel));
    const input = spyArray(['a', 'b']);
    const copy = run(expression, input.array);
    assert.deepEqual(input.calls, { slice: 1, map: 0, callbacks: 0 });
    assert.deepEqual(copy, ['a', 'b']);
    assert.notEqual(copy, input.array, 'the copy is a new array');
    assert.equal(run(expression, 'text'), 'text', 'a non-array passes through');
  }
  const inner = spyArray(['a']);
  const outer = spyArray([inner.array, 'b']);
  const copy = run(render(emitModelFromInit({ kind: 'array', item: strings }, identifier('values'), unusedModel)), outer.array) as unknown[];
  assert.deepEqual(outer.calls, { slice: 0, map: 1, callbacks: 2 }, 'a nested array maps once, a callback for each of its two items');
  assert.deepEqual(inner.calls, { slice: 1, map: 0, callbacks: 0 });
  assert.deepEqual(copy, [['a'], 'b']);
  assert.notEqual(copy[0], inner.array, 'the inner array is copied too');
});

test('the cores and the wire stringify of a module take no options', () => {
  // protects: F-129 lean generated code: no per-call options literal; core functions take no options
  const source = emitCodecRuntimeText(paymentGraph(), validatorNames);
  const names = ['stringifyPaymentCore', 'stringifyMoneyCore', 'toWireFormatPaymentCore', 'toWireFormatMoneyCore', 'stringifyPaymentWire', 'stringifyMoneyWire'];
  const functions = runModule(source.replace(/^export /gm, ''), { ...serde, ...conversion }, { exports: names }) as Record<string, (...args: unknown[]) => unknown>;
  assert.deepEqual(names.map((name) => [name, functions[name].length]), names.map((name) => [name, 1]), 'each takes its value and nothing else');
  assert.equal(instantiateRuntime(source).stringifyPayment.length, 2, 'the public function takes the value and the options');
});

test('a parent module names and defines the validators of its own model, not those of a model it nests', () => {
  // protects: F-129 lean generated code: the parent companion does not duplicate the validator of a nested interned model
  const owner: ModelTypeDescriptor = {
    kind: 'object',
    properties: { pet: { kind: 'generated-model', id: 'Pet' }, id: { kind: 'string' } },
    required: ['pet', 'id'],
    additionalProperties: false,
  };
  const graph = createSchemaGraph();
  graph.intern({ kind: 'generated-model', id: 'Pet' }, 'Pet');
  graph.intern(owner, 'Owner');
  graph.seal();
  const asked: string[] = [];
  const source = emitCodecRuntimeText(graph, {
    nestedGenerated: (id) => identifier(`${id}Model`),
    validatorName: (id) => { asked.push(id.replace(/_[0-9a-f]{8}$/, '')); return identifier(`validate_${id.replace(/[^\w$]/g, '_')}`); },
  });
  assert.deepEqual(asked, ['Owner', 'Owner'], 'validate and assert each name the validator of the parent, none of the nested model');
  const checks = [...source.matchAll(/^export function ((?:validate|assert)\w+)/gm)].map((match) => match[1]);
  assert.deepEqual(checks, ['validateOwner', 'assertOwner'], 'the module defines no check of the nested model');
});

test('validate parses no JSON on a call', async () => {
  // protects: F-129 lean generated code: schema work runs once at module scope, not on every validate call
  const binding = await compileValidationPlanBinding(buildCodecValidationPlan([paymentGraph()], [], {}, true), { fastPath: true });
  const runtime = instantiateRuntime(emitCodecRuntimeText(paymentGraph(), {
    validatorName: (id) => identifier(binding.validatorName(id)),
    fastCheckName: (id) => { const name = binding.fastCheckName(id); return name === undefined ? undefined : identifier(name); },
  }), { ...binding.scope, ...binding.fastScope });
  const value = { id: 'p1', amount: { currency: 'USD', at: new Date(0), tags: ['a'] }, list: [['x']] };
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => { parses += 1; return parse(...args); };
  try {
    assert.equal(runtime.validatePayment(value), true);
    assert.equal(runtime.validatePayment({ ...value, id: 7 }), false);
  } finally {
    JSON.parse = parse;
  }
  assert.equal(parses, 0, 'two validate calls, valid and invalid, parse no JSON');
});

/** The model `Entry` with one field; with `wire` the field is a TSerde field of that wire form. */
function entryGraph(field: ModelTypeDescriptor): ReturnType<typeof createSchemaGraph> {
  const graph = createSchemaGraph();
  graph.intern({ kind: 'object', properties: { value: field }, required: ['value'], additionalProperties: false }, 'Entry');
  graph.seal();
  return graph;
}

/** The validators and the fast checks that the codec of a graph needs compiled into its scope. */
async function compiledChecks(graph: ReturnType<typeof createSchemaGraph>): Promise<{ readonly validators: number; readonly fastChecks: number }> {
  const binding = await compileValidationPlanBinding(buildCodecValidationPlan([graph], [], {}, true), { fastPath: true });
  return { validators: Object.keys(binding.scope).length, fastChecks: Object.keys(binding.fastScope).length };
}

test('a TSerde field whose wire is its model compiles no more validators than a plain field', async () => {
  // protects: F-129 lean generated code: no wire validator when the wire and model schemas are identical
  const plain = await compiledChecks(entryGraph({ kind: 'string' }));
  const identity = await compiledChecks(entryGraph({ kind: 'string', serde: { id: 'same', wire: { kind: 'string' } } }));
  const converted = await compiledChecks(entryGraph({ kind: 'number', serde: { id: 'perm', wire: { kind: 'string' } } }));
  assert.deepEqual(plain, { validators: 1, fastChecks: 1 });
  assert.deepEqual(identity, { validators: 1, fastChecks: 1 }, 'no #wire validator and no wire fast check');
  assert.deepEqual(converted, { validators: 4, fastChecks: 4 }, 'a field whose wire differs compiles the wire and both residual checks');
});

const PERMISSION: ModelTypeDescriptor = {
  kind: 'number',
  constraints: [{ kind: 'maximum', value: 255 }],
  serde: { id: 'permission', wire: { kind: 'string', constraints: [{ kind: 'pattern', value: '^0x[0-9a-f]+$' }] } },
};

test('a TSerde field converts and is checked in one pass', async () => {
  // protects: F-129 lean generated code: a TSerde field converts in one pass
  const graph = entryGraph(PERMISSION);
  const binding = await compileValidationPlanBinding(buildCodecValidationPlan([graph], [], {}, true), { fastPath: true });
  const calls: string[] = [];
  const counted = <T extends (...args: never[]) => unknown>(name: string, run: T): T => ((...args: never[]) => { calls.push(name); return run(...args); }) as T;
  const resolver: StringifySerdeResolver = {
    deserialize: (_id, value) => code`decodePermission(${value} as string)`,
    serialize: (_id, value) => code`encodePermission(${value} as number)`,
  };
  const scope: Record<string, unknown> = {
    decodePermission: counted('decode', (text: string) => Number.parseInt(text, 16)),
    encodePermission: counted('encode', (value: number) => `0x${value.toString(16)}`),
  };
  for (const [name, run] of Object.entries(binding.scope)) scope[name] = counted(name.replace(/^validate_Entry_[0-9a-f]{8}/, 'validate'), run);
  for (const [name, run] of Object.entries(binding.fastScope)) scope[name] = counted(name.replace(/^is_Entry_[0-9a-f]{8}/, 'is'), run);
  const source = emitCodecRuntimeText(graph, {
    validatorName: (id) => identifier(binding.validatorName(id)),
    fastCheckName: (id) => { const name = binding.fastCheckName(id); return name === undefined ? undefined : identifier(name); },
    serde: resolver,
  });
  const runtime = instantiateRuntime(source, scope);
  /** How often each function ran since the last call, by name. */
  const tally = (): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const name of calls.splice(0)) counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  };
  const model = { value: 5 };
  const wire = { value: '0x5' };
  assert.equal(runtime.stringifyEntry(model), '{"value":"0x5"}');
  assert.deepEqual(tally(), { is: 1, encode: 1, is_wire_only: 1 }, 'stringify: one model check, one encode, one wire-only check');
  assert.deepEqual(runtime.toWireFormatEntry(model), wire);
  assert.deepEqual(tally(), { is: 1, encode: 1, is_wire_only: 1 }, 'toWireFormat: the same');
  assert.deepEqual(runtime.parseEntry('{"value":"0x5"}'), model);
  assert.deepEqual(tally(), { is_wire: 1, decode: 1, is_model_only: 1 }, 'parse: one wire check, one decode, one model-only check');
  assert.deepEqual(runtime.fromWireFormatEntry(wire), model);
  assert.deepEqual(tally(), { is_wire: 1, decode: 1, is_model_only: 1 }, 'fromWireFormat: the same');
  runtime.stringifyEntry(model, { validate: false });
  assert.deepEqual(tally(), { encode: 1 }, 'trusted stringify only encodes');
  runtime.parseEntry('{"value":"0x5"}', { validate: false });
  assert.deepEqual(tally(), { decode: 1 }, 'trusted parse only decodes');
  assert.throws(() => runtime.parseEntry('{"value":"nope"}'), /validation/i);
  assert.deepEqual(tally(), { is_wire: 1, validate_wire: 1 }, 'an invalid wire stops at the wire check, which reports its issues once, and decodes nothing');
});
