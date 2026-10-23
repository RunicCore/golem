import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResults, controlSpread, type MeasuredCase } from '../scripts/benchmark/results.js';
import { isBenchmarkResults } from '../scripts/benchmark/results-schema.js';

const sample = [{ iterations: 1000, elapsedMs: 10 }];
const measured = (operation: MeasuredCase['operation'], payload: MeasuredCase['payload'] = 'simple'): MeasuredCase =>
  ({ payload, operation, adapter: 'golem-object-off', payloadBytes: 100, samples: sample });
const speeds = (...opsPerSec: number[]) => ({ samples: opsPerSec.map(iterations => ({ iterations, elapsedMs: 1000 })) });
const control = (operation: MeasuredCase['operation'], ...opsPerSec: number[]): MeasuredCase =>
  ({ payload: 'simple', operation, adapter: 'control', payloadBytes: 100, ...speeds(...opsPerSec) });
const loadAverage = { start: [1.5, 1, 0.5], end: [2, 1.5, 1] };
const input = (operations: readonly MeasuredCase['operation'][]) => ({
  measured: [...operations.map(operation => measured(operation)), control('parse', 100, 110, 90), control('stringify', 200, 200, 200)],
  loadAverage,
  settings: { warmupMs: 1, batchMs: 1, batches: 2, rounds: 1 },
  environment: { node: 'v24', os: 'linux', arch: 'arm64', cpu: 'test', cpus: 1 },
  git: { sha: 'abc', dirty: false },
  packages: {},
  measuredAt: '2026-10-22T00:00:00.000Z',
  adapters: ['golem-object-off'] as const,
  payloads: ['simple'] as const,
});

// protects: T-235 a cost case with no measurement stops the build of the results
test('building the results refuses a cost case that has no measurement', () => {
  assert.throws(() => buildResults(input(['parse', 'stringify', 'decode'])), /missing measurement simple\/encode\/golem-object-off/);
});

// protects: T-235 schema 3 carries decode and encode in a required cost section
test('the results hold the cost timings, decode and encode included, and pass the schema', () => {
  const results = buildResults(input(['parse', 'stringify', 'decode', 'encode']));
  assert.deepEqual(results.cost?.cases.map(c => `${c.operation}:${c.opsPerSec?.median}`), ['parse:100000', 'stringify:100000', 'decode:100000', 'encode:100000']);
  assert.deepEqual(results.cases, []);
  assert.equal(isBenchmarkResults(results), true);
  assert.equal(isBenchmarkResults({ ...results, cost: { cases: [{ payload: 'simple', operation: 'decode', adapter: 'golem-object-off', support: 'full' }] } }), false);
});

// protects: T-236 the serde payloads are cost-table payloads only
test('the serde payloads are timed into the cost section and stay out of the compare table payload list', () => {
  const results = buildResults({ ...input([]), measured: [...['parse', 'stringify', 'decode', 'encode'].map(operation => measured(operation as MeasuredCase['operation'], 'serde-many')), control('parse', 100, 100, 100)], payloads: ['serde-many'] });
  assert.deepEqual(results.cost?.cases.map(c => `${c.payload}/${c.operation}`), ['serde-many/parse', 'serde-many/stringify', 'serde-many/decode', 'serde-many/encode']);
  assert.deepEqual(results.payloads, []);
  assert.equal(isBenchmarkResults(results), true);
});

// protects: T-238 the control's spread is the median over its cases of (max - min) / median
test('the control spread is the median over the control cases of range over median speed', () => {
  // Case spreads: (110 - 90) / 100 = 0.2, 0, and (150 - 100) / 100 = 0.5.
  assert.equal(controlSpread([speeds(100, 110, 90), speeds(200, 200, 200), speeds(100, 150, 100)]), 0.2);
  // Two cases: the mean of the two middle spreads.
  assert.equal(controlSpread([speeds(100, 110, 90), speeds(100, 100, 100)]), 0.1);
  assert.throws(() => controlSpread([]), /no control case/);
});

// protects: T-238 every run stores the host load and the control's noise band
test('the results carry the host load and the control spread, and refuse a run without them', () => {
  const base = input(['parse', 'stringify', 'decode', 'encode']);
  const results = buildResults(base);
  assert.deepEqual(results.noise, { loadAverage, controlSpread: 0.1 });
  assert.equal(isBenchmarkResults(results), true);
  assert.equal(isBenchmarkResults({ ...results, noise: { ...results.noise, loadAverage: { start: [1, 1], end: loadAverage.end } } }), false);
  assert.equal(isBenchmarkResults({ ...results, noise: { loadAverage, controlSpread: -1 } }), false);
  assert.throws(() => buildResults({ ...base, loadAverage: undefined }), /missing the host load average/);
  assert.throws(() => buildResults({ ...base, measured: base.measured.filter(m => m.adapter !== 'control') }), /missing the control timing/);
});

// protects: T-242 schema 3 requires the cost, noise and invalid sections; a schema 2 file still passes
test('schema 3 needs the cost, noise and invalid sections, and a schema 2 file without them is still accepted', () => {
  const results = buildResults(input(['parse', 'stringify', 'decode', 'encode']));
  assert.equal(results.schema, 3);
  for (const section of ['cost', 'noise', 'invalid'] as const) {
    assert.equal(isBenchmarkResults({ ...results, [section]: undefined }), false, `schema 3 without ${section}`);
  }
  assert.equal(isBenchmarkResults({ ...results, schema: 2, cost: undefined, noise: undefined, invalid: undefined }), true);
  assert.equal(isBenchmarkResults({ ...results, invalid: { cases: [{ payload: 'simple', operation: 'parse', adapter: 'golem-validated', support: 'full' }] } }), false);
});

// protects: R-30 a corrupt payload or adapter field stops the docs build instead of showing "NaN B"
test('the schema refuses a payload without its size and an adapter without its label', () => {
  const results = buildResults(input(['parse', 'stringify', 'decode', 'encode']));
  assert.equal(isBenchmarkResults({ ...results, payloads: [{ ...results.payloads[0], bytes: 'big' }] }), false);
  assert.equal(isBenchmarkResults({ ...results, payloads: [{ ...results.payloads[0], label: undefined }] }), false);
  assert.equal(isBenchmarkResults({ ...results, adapters: [{ ...results.adapters[0], label: 3 }] }), false);
});

// protects: T-242 invalid input is timed on its own and a missing invalid timing stops the build
test('the results hold the invalid timings apart from the valid ones, and refuse a missing invalid timing', () => {
  const valid = (['parse', 'stringify', 'validate', 'decode', 'encode'] as const).map(operation => ({ ...measured(operation), adapter: 'golem-validated' as const }));
  const rejected = (operation: MeasuredCase['operation'], ops: number): MeasuredCase => ({ ...measured(operation), adapter: 'golem-validated', invalid: true, ...speeds(ops) });
  const base = { ...input([]), adapters: ['golem-validated'] as const };
  const withInvalid = (...invalid: MeasuredCase[]) => buildResults({ ...base, measured: [...base.measured, ...valid, ...invalid] });
  const results = withInvalid(rejected('parse', 40), rejected('decode', 50), rejected('validate', 60));
  assert.deepEqual(results.invalid?.cases.map(c => `${c.operation}:${c.opsPerSec?.median}`), ['parse:40', 'decode:50', 'validate:60']);
  assert.deepEqual(results.cases.filter(c => c.operation === 'parse').map(c => c.opsPerSec?.median), [100000]);
  assert.throws(() => withInvalid(rejected('parse', 40), rejected('decode', 50)), /missing measurement simple\/validate\/golem-validated\/invalid/);
});
