import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BenchmarkResults, ResultCase } from '../scripts/benchmark/results-schema.js';
import { FULL_RESULTS_FILE } from '../scripts/benchmark/results-schema.js';
import { benchmarkSiteProjection, buildBenchmarkSiteProjection } from '../scripts/benchmark/site-projection.js';

const timed = (payload: string, operation: string, adapter: string, median: number): ResultCase =>
  ({ payload, operation, adapter, support: 'full', opsPerSec: { median, min: median, max: median } });
const adapter = (id: string, group: string, label: string, library: string) => ({ id, group, label, library, checked: true, sourceUrl: `https://example.test/${id}.ts` });
const blob = 'https://github.com/RunicCore/golem/blob/master/scripts/benchmark/fixtures/upstream';

const results: BenchmarkResults = {
  schema: 2,
  measuredAt: '2026-10-22T07:55:27.827Z',
  git: { sha: 'abcdef0123', dirty: false },
  environment: { node: 'v24.0.0', os: 'linux', arch: 'arm64', cpu: 'Test CPU', cpus: 1 },
  packages: {},
  settings: { warmupMs: 1, batchMs: 1, batches: 4, rounds: 2 },
  groups: [
    { id: 'plain', label: 'Plain objects', description: 'Plain objects.' },
    { id: 'classes', label: 'Class instances', description: 'Class instances.' },
    { id: 'validated-classes', label: 'Validated class instances', description: 'Checked class instances.' },
  ],
  payloads: [{ id: 'simple', label: 'Simple object', bytes: 123, description: 'Four 3D points.', sourceUrl: 'https://example.test/shared.ts' }],
  operations: [
    { id: 'parse', label: 'Parse', description: 'Parse.' },
    { id: 'stringify', label: 'Stringify', description: 'Stringify.' },
    { id: 'validate', label: 'Validate', description: 'Validate.' },
  ],
  adapters: [
    adapter('golem-object', 'plain', 'Golem (IObject)', '@exprtlabs/golem'),
    adapter('typia', 'plain', 'Typia', 'typia'),
    adapter('zod', 'plain', 'Zod', 'zod'),
    adapter('golem', 'classes', 'Golem (IModel)', '@exprtlabs/golem'),
    adapter('class-transformer', 'classes', 'class-transformer', 'class-transformer'),
    adapter('golem-validated', 'validated-classes', 'Golem (IModel, validated)', '@exprtlabs/golem'),
    adapter('class-validator', 'validated-classes', 'class-transformer + class-validator', 'class-validator'),
  ],
  cases: [
    timed('simple', 'parse', 'golem-object', 400), timed('simple', 'parse', 'typia', 999), timed('simple', 'parse', 'zod', 150),
    timed('simple', 'parse', 'golem', 200), timed('simple', 'parse', 'class-transformer', 170), timed('simple', 'parse', 'golem-validated', 100), timed('simple', 'parse', 'class-validator', 90),
    timed('simple', 'stringify', 'golem-object', 60), timed('simple', 'stringify', 'typia', 70), timed('simple', 'stringify', 'golem', 50), timed('simple', 'stringify', 'golem-validated', 40),
    timed('simple', 'validate', 'golem-object', 900), timed('simple', 'validate', 'zod', 20), timed('simple', 'validate', 'golem-validated', 800), timed('simple', 'validate', 'class-validator', 30),
  ],
  cost: { cases: [timed('simple', 'parse', 'golem-object-off', 800)] },
};

// protects: R-30 the site gets golem's own numbers and the cost table, and no other library
test('the site projection holds the golem columns, golem rows per payload and the cost table of a run that timed other libraries', () => {
  const projection = benchmarkSiteProjection(results);
  assert.equal(projection.measured, 'Measured 2026-10-22 · Node v24.0.0 · Test CPU · linux/arm64 · abcdef0 · median ops/s of 4 batches');
  assert.deepEqual(projection.columns, [
    { id: 'golem-object', label: 'Golem (IObject)', sourceUrl: `${blob}/golem-object.ts`, series: 's1' },
    { id: 'golem', label: 'Golem (IModel)', sourceUrl: `${blob}/golem.ts`, series: 's2' },
    { id: 'golem-validated', label: 'Golem (IModel, validated)', sourceUrl: `${blob}/golem.ts`, series: 's3' },
  ]);
  assert.deepEqual(projection.speeds, [{
    payload: { id: 'simple', label: 'Simple object', bytes: 123, description: 'Four 3D points. Measures per-call overhead.', sourceUrl: `${blob}/shared.ts` },
    rows: [
      { operation: { id: 'parse', label: 'Parse' }, cells: [400, 200, 100] },
      { operation: { id: 'stringify', label: 'Stringify' }, cells: [60, 50, 40] },
      { operation: { id: 'validate', label: 'Validate' }, cells: [900, null, 800] },
    ],
  }]);
  assert.deepEqual(projection.cost.map(block => [block.payload.label, ...block.rows.map(row => row.operation.label)]), [['Simple object', 'Parse', 'Stringify', 'Validate']]);
  assert.deepEqual(projection.cost[0].rows[0].cells, {
    imodelOff: { kind: 'ops', value: 200 }, imodelOn: { kind: 'ops', value: 100 }, imodelOnOverOff: { kind: 'ratio', value: 0.5 },
    iobjectOff: { kind: 'ops', value: 800 }, iobjectOn: { kind: 'ops', value: 400 }, iobjectOnOverOff: { kind: 'ratio', value: 0.5 },
    imodelOverIobject: { kind: 'ratio', value: 0.25 }, serdeManyOverNone: { kind: 'not-applicable' }, invalidOverValid: { kind: 'not-run' },
  });
});

const committed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../..', FULL_RESULTS_FILE), 'utf8'));
/** The workspace root that docs/.vitepress/config.ts hands to buildBenchmarkSiteProjection, holding the given results file. */
const workspaceWith = (results: unknown): string => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'golem-results-'));
  mkdirSync(path.dirname(path.join(workspace, FULL_RESULTS_FILE)), { recursive: true });
  writeFileSync(path.join(workspace, FULL_RESULTS_FILE), typeof results === 'string' ? results : JSON.stringify(results));
  return workspace;
};
const corrupt = {
  'a payload size that is not a number': { ...committed, payloads: [{ ...committed.payloads[0], bytes: 'big' }, ...committed.payloads.slice(1)] },
  'a payload size that NaN left as null': { ...committed, payloads: [{ ...committed.payloads[0], bytes: null }, ...committed.payloads.slice(1)] },
  'an adapter without its label': { ...committed, adapters: [{ ...committed.adapters[0], label: undefined }, ...committed.adapters.slice(1)] },
  'a schema 3 file without its cost section': { ...committed, cost: undefined },
  'a file cut off in the middle': JSON.stringify(committed).slice(0, 400),
};
for (const [name, results] of Object.entries(corrupt)) {
  // protects: R-30 a corrupt results file stops the docs build before the page shows "NaN B"
  test(`the docs build reads results.json and stops on ${name}`, () => {
    const workspace = workspaceWith(results);
    try {
      assert.throws(() => buildBenchmarkSiteProjection(workspace), typeof results === 'string' ? SyntaxError : /is not a valid results file/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

// protects: R-30 the committed results file passes the docs build and every size on the page is a number
test('the docs build projects the committed results.json with a finite size for every payload', () => {
  const workspace = workspaceWith(committed);
  try {
    const projection = buildBenchmarkSiteProjection(workspace);
    assert.ok(projection.speeds.length > 0);
    assert.deepEqual(projection.speeds.filter(block => !Number.isFinite(block.payload.bytes)), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
