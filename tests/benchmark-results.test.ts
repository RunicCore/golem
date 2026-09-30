import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { timedCases } from '../scripts/benchmark/cases.js';
import { isBenchmarkResults } from '../scripts/benchmark/results-schema.js';
import { buildResults, summarize, writeFilesTogether, type MeasuredCase } from '../scripts/benchmark/results.js';

const settings = { warmupMs: 300, batchMs: 200, batches: 5 };
const env = { node: 'v22.12.0', os: 'darwin', arch: 'arm64', cpu: 'Test CPU', cpus: 8 };

function measuredAll(): MeasuredCase[] {
  return timedCases().map(c => ({ payload: c.payload, operation: c.operation, adapter: c.adapter, payloadBytes: 100,
    samples: [{ iterations: 100, elapsedMs: 200 }, { iterations: 300, elapsedMs: 200 }, { iterations: 200, elapsedMs: 200 }] }));
}

test('summarize takes median, min and max over per-batch ops/s and rejects empty, zero and non-finite samples', () => {
  assert.deepEqual(summarize([{ iterations: 100, elapsedMs: 200 }, { iterations: 300, elapsedMs: 200 }, { iterations: 200, elapsedMs: 200 }]),
    { median: 1000, min: 500, max: 1500 });
  assert.deepEqual(summarize([{ iterations: 1, elapsedMs: 1 }, { iterations: 3, elapsedMs: 1 }]), { median: 2000, min: 1000, max: 3000 });
  assert.throws(() => summarize([]), /no samples/);
  assert.throws(() => summarize([{ iterations: 0, elapsedMs: 200 }]), /invalid sample/);
  assert.throws(() => summarize([{ iterations: 10, elapsedMs: 0 }]), /invalid sample/);
  assert.throws(() => summarize([{ iterations: 10, elapsedMs: Infinity }]), /invalid sample/);
  assert.throws(() => summarize([{ iterations: Infinity, elapsedMs: 10 }]), /invalid sample/);
});

test('isBenchmarkResults rejects malformed metadata', () => {
  const valid = buildResults({ measured: measuredAll(), settings, environment: env, git: { sha: 'abc', dirty: false }, packages: { zod: '4.6.5' }, measuredAt: '2026-09-27T00:00:00.000Z' });
  assert.ok(isBenchmarkResults(valid));
  for (const broken of [
    { measuredAt: 5 },
    { git: { sha: 'abc' } },
    { environment: { ...env, cpus: 'eight' } },
    { environment: undefined },
    { packages: { zod: 4 } },
    { settings: { warmupMs: 300, batchMs: 200 } },
    { schema: 1 },
    { adapters: [{ ...valid.adapters[0], group: 'unknown' }, ...valid.adapters.slice(1)] },
    { cases: [{ ...valid.cases[0], support: 'partial' }] },
  ]) assert.equal(isBenchmarkResults({ ...valid, ...broken }), false, JSON.stringify(broken));
});

test('buildResults emits every case with support, notes, timings, groups and each adapter\'s group', () => {
  const results = buildResults({ measured: measuredAll(), settings, environment: env, git: { sha: 'abc', dirty: false }, packages: { zod: '4.6.5' }, measuredAt: '2026-09-27T00:00:00.000Z' });
  assert.ok(isBenchmarkResults(results));
  const none = results.cases.filter(c => c.support === 'none');
  assert.ok(none.length > 0 && none.every(c => c.opsPerSec === undefined && c.note));
  assert.equal(results.payloads.find(p => p.id === 'simple')?.bytes, 100);
  assert.ok(results.adapters.every(a => a.sourceUrl.startsWith('https://github.com/RunicCore/golem/blob/master/')));
  assert.ok(JSON.stringify(results).length < 30_000);
  assert.equal(results.schema, 2);
  assert.deepEqual(results.groups.map(g => g.id), ['plain', 'classes', 'validated-classes']);
  assert.equal(results.adapters.find(a => a.id === 'golem-object')?.group, 'plain');
});

test('buildResults throws when a timed case has no measurement', () => {
  assert.throws(() => buildResults({ measured: measuredAll().slice(1), settings, environment: env, git: { sha: 'abc', dirty: false }, packages: {}, measuredAt: 'x' }), /missing measurement/);
});

test('writeFilesTogether keeps the previous file when producing content fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-write-'));
  const file = path.join(dir, 'results.json');
  try {
    writeFileSync(file, 'previous');
    assert.throws(() => writeFilesTogether([[file, () => { throw new Error('boom'); }]]), /boom/);
    assert.equal(readFileSync(file, 'utf8'), 'previous');
    writeFilesTogether([[file, () => 'next']]);
    assert.equal(readFileSync(file, 'utf8'), 'next');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeFilesTogether changes no file when any write fails before the renames and leaves no temporary file when a replace fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-write-'));
  try {
    const raw = path.join(dir, 'raw.json');
    writeFileSync(raw, 'previous');
    writeFileSync(path.join(dir, 'blocker'), '');
    const results = path.join(dir, 'blocker', 'results.json'); // parent is a file, so this write fails
    assert.throws(() => writeFilesTogether([[raw, () => 'next raw'], [results, () => 'next results']]));
    assert.equal(readFileSync(raw, 'utf8'), 'previous');
    assert.deepEqual(readdirSync(dir).sort(), ['blocker', 'raw.json']);
    writeFilesTogether([[raw, () => 'next raw'], [path.join(dir, 'results.json'), () => 'next results']]);
    assert.equal(readFileSync(raw, 'utf8'), 'next raw');
    assert.equal(readFileSync(path.join(dir, 'results.json'), 'utf8'), 'next results');
    const taken = path.join(dir, 'taken');
    mkdirSync(path.join(taken, 'occupied'), { recursive: true }); // a non-empty directory cannot be replaced by a file
    assert.throws(() => writeFilesTogether([[taken, () => 'next']]));
    assert.deepEqual(readdirSync(dir).sort(), ['blocker', 'raw.json', 'results.json', 'taken'], 'no temporary file is left when the replace fails');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
