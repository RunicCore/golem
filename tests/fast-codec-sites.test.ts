import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LibError } from '@exprtlabs/golem/errors';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { createSchemaGraph } from '@exprtlabs/golem/schema-graph';
import { emitCodecRuntime } from '@exprtlabs/golem/emitter';
import { buildCodecValidationPlan } from '@exprtlabs/golem/validation-plan';
import type { Validator } from '@exprtlabs/golem/validation-runtime';

import { instantiateRuntime, type RuntimeFunction } from './emitted-runtime.js';
import { compileValidationPlanBinding, type FastCheck } from './support/compiled-validators.js';

// The generated codec of one model `Order`, run on its compiled validators. The scope the codec runs in is the test's:
// each validator and fast check in it counts its calls, which shows the route a value took (spec 7.1).

const RULES_MODULE = 'export const positive = value => { globalThis.positiveCalls = (globalThis.positiveCalls ?? 0) + 1; return typeof value === "number" && value > 0; };';

interface Codec {
  readonly functions: Record<string, RuntimeFunction>;
  /** Calls of the full validators and of the fast checks since the codec was made. */
  readonly calls: { validator: number; fast: number };
}

async function orderCodec(descriptor: ModelTypeDescriptor, fastPath: boolean): Promise<Codec> {
  const graph = createSchemaGraph();
  graph.intern(descriptor, 'Order');
  graph.seal();
  const binding = await compileValidationPlanBinding(buildCodecValidationPlan([graph], [], {}, true), {
    fastPath,
    validations: { positive: { importPath: './rules.mjs', exportName: 'positive' } },
    modules: { 'rules.mjs': RULES_MODULE },
  });
  const calls = { validator: 0, fast: 0 };
  const countValidator = (run: Validator): Validator => (value, all) => {
    calls.validator++;
    return run(value, all);
  };
  const countFast = (run: FastCheck): FastCheck => value => {
    calls.fast++;
    return run(value);
  };
  const scope = {
    ...Object.fromEntries(Object.entries(binding.scope).map(([name, run]) => [name, countValidator(run)])),
    ...Object.fromEntries(Object.entries(binding.fastScope).map(([name, run]) => [name, countFast(run)])),
  };
  const source = emitCodecRuntime(graph, { validatorName: binding.validatorName, fastCheckName: binding.fastCheckName });
  return { functions: instantiateRuntime(source, scope), calls };
}

const order = (properties: Record<string, ModelTypeDescriptor>, required: readonly string[]): ModelTypeDescriptor => ({
  kind: 'object', properties, required, additionalProperties: false,
});

const hidden = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const result = { ...value };
  Object.defineProperty(result, key, { value: result[key], enumerable: false });
  return result;
};

const LINE = order({ sku: { kind: 'string' }, qty: { kind: 'number' } }, ['sku', 'qty']);

const FIXTURES: readonly (readonly [name: string, descriptor: ModelTypeDescriptor, valid: unknown, invalid: unknown])[] = [
  ['a Date field', order({ id: { kind: 'string' }, at: { kind: 'date' } }, ['id', 'at']), { id: 'a', at: new Date(0) }, { id: 'a', at: new Date(Number.NaN) }],
  ['an undefined-valued optional field', order({ id: { kind: 'string' }, note: { kind: 'string' } }, ['id']), { id: 'a', note: undefined }, { id: 'a', note: 1 }],
  ['a non-enumerable field', order({ id: { kind: 'string' } }, ['id']), hidden({ id: 'a', extra: 1 }, 'extra'), hidden({ id: 'a' }, 'id')],
  ['an array of nested objects', order({ lines: { kind: 'array', item: LINE } }, ['lines']), { lines: [{ sku: 'a', qty: 1 }] }, { lines: [{ sku: 'a' }] }],
];

for (const [name, descriptor, valid, invalid] of FIXTURES) {
  test(`generated codec, ${name}: a valid value takes the fast route, an invalid one the validator's`, async () => {
    const { functions, calls } = await orderCodec(descriptor, true);
    assert.equal(functions.validateOrder(valid), true);
    assert.equal(functions.assertOrder(valid), valid);
    assert.deepEqual({ ...calls }, { validator: 0, fast: 2 });
    assert.equal(functions.validateOrder(invalid), false);
    assert.throws(() => functions.assertOrder(invalid), LibError);
    assert.deepEqual({ ...calls }, { validator: 2, fast: 4 });
  });
}

test('generated codec with a TValidation predicate keeps the validator route, and the predicate runs once per conversion', async () => {
  const { functions, calls } = await orderCodec(order({ amount: { kind: 'number', validations: ['positive'] } }, ['amount']), true);
  Reflect.set(globalThis, 'positiveCalls', 0);
  assert.equal(functions.validateOrder({ amount: 5 }), true);
  assert.throws(() => functions.assertOrder({ amount: -1 }), LibError);
  assert.deepEqual({ ...calls, predicate: Reflect.get(globalThis, 'positiveCalls') }, { validator: 2, fast: 0, predicate: 2 });
});

// Golden: a failing value gives the same error, issues and messages with the fast check as without it.
const FAILING: readonly (readonly [descriptor: ModelTypeDescriptor, value: unknown])[] = [
  ...FIXTURES.map(([, descriptor, , invalid]) => [descriptor, invalid] as const),
  [order({ id: { kind: 'string' }, at: { kind: 'date' } }, ['id', 'at']), { at: 'x', extra: true }],
  [order({ lines: { kind: 'array', item: LINE } }, ['lines']), { lines: [{ qty: 'one' }, 5] }],
  [order({ amount: { kind: 'number', validations: ['positive'] } }, ['amount']), { amount: -1 }],
];

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof LibError ? { message: error.message, kind: error.kind, issues: error.issues } : error;
  }
  return 'no error';
}

test('failing values report the same error, issues and messages with the fast check as without it', async () => {
  const outcomes = async (fastPath: boolean): Promise<readonly unknown[]> => Promise.all(FAILING.map(async ([descriptor, value]) => {
    const { functions } = await orderCodec(descriptor, fastPath);
    return [failure(() => functions.assertOrder(value)), failure(() => functions.assertOrder(value, { failFast: false })), failure(() => functions.fromWireFormatOrder(value, { validate: true }))];
  }));
  const [fast, full] = await Promise.all([outcomes(true), outcomes(false)]);
  assert.deepEqual(fast, full);
  assert.ok(full.flat().every(entry => entry !== 'no error'), 'every value fails');
});
