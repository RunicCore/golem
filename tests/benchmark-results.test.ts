import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResults, type MeasuredCase } from '../scripts/benchmark/results.js';
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
