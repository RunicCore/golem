import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CASES, timedCases } from '../scripts/benchmark/cases.js';
import { isBenchmarkResults } from '../scripts/benchmark/results-schema.js';
import { runBenchmark } from '../scripts/benchmark/run.js';

test('a smoke run verifies and measures every timed case and writes a valid results file', { timeout: 600_000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-run-'));
  const outputFile = path.join(dir, 'results.json');
  const rawFile = path.join(dir, 'raw.json');
  try {
    const results = runBenchmark({ settings: { warmupMs: 0, batchMs: 1, batches: 2, rounds: 2 }, outputFile, rawFile, log: () => {} });
    assert.ok(isBenchmarkResults(results));
    assert.equal(results.cases.length, CASES.length);
    assert.equal(results.cases.filter(c => c.opsPerSec).length, timedCases().length);
    const written: unknown = JSON.parse(readFileSync(outputFile, 'utf8'));
    assert.deepEqual(written, results);
    assert.ok(existsSync(rawFile));
    // Each round contributes its share of batches to every case.
    const raw = JSON.parse(readFileSync(rawFile, 'utf8')) as { measured: { samples: unknown[] }[] };
    assert.ok(raw.measured.every(c => c.samples.length === 2), 'each case has one batch from each of the two rounds');
    assert.ok(results.payloads.every(p => p.bytes > 0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
