import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResults, controlSpread, type MeasuredCase } from '../scripts/benchmark/results.js';
import { isBenchmarkResults } from '../scripts/benchmark/results-schema.js';

const sample = [{ iterations: 1000, elapsedMs: 10 }];
const measured = (operation: MeasuredCase['operation'], payload: MeasuredCase['payload'] = 'simple'): MeasuredCase =>
  ({ payload, operation, adapter: 'golem-object-off', payloadBytes: 100, samples: sample });
const input = (operations: readonly MeasuredCase['operation'][]) => ({
  measured: operations.map(operation => measured(operation)),
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

// protects: T-235 schema 2 carries decode and encode in an optional cost section
test('the results hold the cost timings, decode and encode included, and still pass the schema', () => {
  const results = buildResults(input(['parse', 'stringify', 'decode', 'encode']));
  assert.deepEqual(results.cost?.cases.map(c => `${c.operation}:${c.opsPerSec?.median}`), ['parse:100000', 'stringify:100000', 'decode:100000', 'encode:100000']);
  assert.deepEqual(results.cases, []);
  assert.equal(isBenchmarkResults(results), true);
  assert.equal(isBenchmarkResults({ ...results, cost: { cases: [{ payload: 'simple', operation: 'decode', adapter: 'golem-object-off', support: 'full' }] } }), false);
});

// protects: T-236 the serde payloads are cost-table payloads only
test('the serde payloads are timed into the cost section and stay out of the compare table payload list', () => {
  const results = buildResults({ ...input([]), measured: ['parse', 'stringify', 'decode', 'encode'].map(operation => measured(operation as MeasuredCase['operation'], 'serde-many')), payloads: ['serde-many'] });
  assert.deepEqual(results.cost?.cases.map(c => `${c.payload}/${c.operation}`), ['serde-many/parse', 'serde-many/stringify', 'serde-many/decode', 'serde-many/encode']);
  assert.deepEqual(results.payloads, []);
  assert.equal(isBenchmarkResults(results), true);
});

const speeds = (...opsPerSec: number[]) => ({ samples: opsPerSec.map(iterations => ({ iterations, elapsedMs: 1000 })) });

// protects: T-238 the control's spread is the median over its cases of (max - min) / median
test('the control spread is the median over the control cases of range over median speed', () => {
  // Case spreads: (110 - 90) / 100 = 0.2, 0, and (150 - 100) / 100 = 0.5.
  assert.equal(controlSpread([speeds(100, 110, 90), speeds(200, 200, 200), speeds(100, 150, 100)]), 0.2);
  // Two cases: the mean of the two middle spreads.
  assert.equal(controlSpread([speeds(100, 110, 90), speeds(100, 100, 100)]), 0.1);
  assert.throws(() => controlSpread([]), /no control case/);
});

// protects: T-238 every run stores the host load and the control's noise band, in schema 2
test('the results carry the host load and the control spread, and the schema accepts files with and without them', () => {
  const loadAverage = { start: [1.5, 1, 0.5], end: [2, 1.5, 1] };
  const control = (operation: MeasuredCase['operation'], ...opsPerSec: number[]): MeasuredCase =>
    ({ payload: 'simple', operation, adapter: 'control', payloadBytes: 100, ...speeds(...opsPerSec) });
  const base = input(['parse', 'stringify', 'decode', 'encode']);
  const results = buildResults({ ...base, measured: [...base.measured, control('parse', 100, 110, 90), control('stringify', 200, 200, 200)], loadAverage });
  assert.deepEqual(results.noise, { loadAverage, controlSpread: 0.1 });
  assert.equal(isBenchmarkResults(results), true);
  assert.equal(isBenchmarkResults({ ...results, noise: undefined }), true);
  assert.equal(isBenchmarkResults({ ...results, noise: { ...results.noise, loadAverage: { start: [1, 1], end: loadAverage.end } } }), false);
  assert.equal(isBenchmarkResults({ ...results, noise: { loadAverage, controlSpread: -1 } }), false);
  assert.equal(buildResults({ ...base, loadAverage }).noise, undefined, 'a run with no control timing has no noise band');
});
