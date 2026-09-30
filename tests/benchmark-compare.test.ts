import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareResults, formatComparison, main } from '../scripts/benchmark/compare.js';
import type { BenchmarkResults, ResultCase } from '../scripts/benchmark/results-schema.js';

function results(cases: ResultCase[], overrides: Partial<BenchmarkResults> = {}): BenchmarkResults {
  return {
    schema: 2, measuredAt: '2026-09-27T00:00:00.000Z', git: { sha: 'a', dirty: false },
    environment: { node: 'v22.12.0', os: 'darwin', arch: 'arm64', cpu: 'CPU', cpus: 8 },
    packages: { zod: '4.6.5' }, settings: { warmupMs: 300, batchMs: 200, batches: 5 },
    groups: [], payloads: [], operations: [], adapters: [], cases, ...overrides,
  };
}
const c = (adapter: string, median: number, min: number, max: number): ResultCase =>
  ({ payload: 'simple', operation: 'parse', adapter, support: 'full', opsPerSec: { median, min, max } });

test('delta percent and overlap per shared case', () => {
  const out = compareResults(results([c('codegen', 1000, 900, 1100), c('zod', 500, 450, 550)]), results([c('codegen', 1200, 1150, 1250), c('zod', 510, 480, 540)]));
  const codegen = out.rows.find(r => r.key === 'simple/parse/codegen');
  assert.equal(codegen?.deltaPercent, 20);
  assert.equal(codegen?.overlap, false);
  assert.equal(out.rows.find(r => r.key === 'simple/parse/zod')?.overlap, true);
});

test('cases present on one side are listed, not dropped', () => {
  const out = compareResults(results([c('codegen', 1, 1, 1)]), results([c('zod', 1, 1, 1)]));
  assert.deepEqual(out.onlyBefore, ['simple/parse/codegen']);
  assert.deepEqual(out.onlyAfter, ['simple/parse/zod']);
  assert.match(formatComparison(out), /only in before: simple\/parse\/codegen/);
});

test('unsupported cases are skipped without NaN', () => {
  const none: ResultCase = { payload: 'simple', operation: 'validate', adapter: 'class-transformer', support: 'none', note: 'no validation here' };
  const out = compareResults(results([none]), results([none]));
  assert.equal(out.rows.length, 0);
  assert.doesNotMatch(formatComparison(out), /NaN/);
});

test('environment, package, settings, git and support changes produce warnings', () => {
  const envBefore = results([c('codegen', 1, 1, 1)]);
  const envAfter = results([c('codegen', 1, 1, 1)], { environment: { ...envBefore.environment, node: 'v24.0.0' }, packages: { zod: '4.7.0' } });
  const envOut = compareResults(envBefore, envAfter);
  assert.ok(envOut.warnings.some(w => w.includes('node')), 'node');
  assert.ok(envOut.warnings.some(w => w.includes('zod')), 'zod');

  const before = results([c('codegen', 1, 1, 1)]);
  const after = results([{ payload: 'simple', operation: 'parse', adapter: 'codegen', support: 'none', note: 'not supported' }], {
    settings: { warmupMs: 300, batchMs: 100, batches: 5 }, git: { sha: 'b', dirty: true },
  });
  const out = compareResults(before, after);
  assert.ok(out.warnings.some(w => w.includes('batchMs')), 'settings');
  assert.ok(out.warnings.some(w => w.includes('git')), 'git');
  assert.ok(out.warnings.some(w => w.includes('simple/parse/codegen') && w.includes('none')), 'support');
});

test('comparing a schema-1 file fails with a clear message', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
  try {
    const old = path.join(dir, 'old.json');
    writeFileSync(old, JSON.stringify({ ...results([]), schema: 1 }));
    assert.throws(() => main([old, old]), /old\.json is not a schema-2 benchmark results file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
