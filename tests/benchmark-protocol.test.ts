import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkerJob, parseWorkerOutput } from '../scripts/benchmark/worker-protocol.js';

test('parseWorkerOutput accepts output and rejects malformed input', () => {
  const output = { fixtureAdapter: 'zod', checksum: 7, cases: [{ fixture: 'ObjectSimple', operation: 'validate', payloadBytes: 10, samples: [{ iterations: 1, elapsedMs: 2 }] }] };
  assert.deepEqual(parseWorkerOutput(JSON.stringify(output)), output);
  for (const broken of ['', '[]', JSON.stringify({ ...output, checksum: 'x' }), JSON.stringify({ ...output, cases: [{ fixture: 'ObjectSimple', operation: 'validate', payloadBytes: 10, samples: [{ iterations: 1 }] }] })]) {
    assert.throws(() => parseWorkerOutput(broken), /worker output/i, broken);
  }
});

test('a measuring worker never runs a library check; a verifying worker does', async t => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A library check that sends invalid input would prime the timed validator; here it fails loudly instead.
  const module = path.join(dir, 'cases.mjs');
  writeFileSync(module, `export async function createComparisonFixtures() {
  return [{ name: 'ObjectSimple', payload: { a: 1 }, operations: { validate: () => true },
    consume: () => 1, verify: async () => { throw new Error('library check ran'); } }];
}
`);
  const worker = fileURLToPath(new URL('../scripts/benchmark/worker.js', import.meta.url));
  const run = (mode: 'verify' | 'measure') => spawnSync(process.execPath, [worker, module, 'zod',
    JSON.stringify({ mode, settings: { warmupMs: 0, batchMs: 1, batches: 1, rounds: 1 }, cases: [{ fixture: 'ObjectSimple', operation: 'validate' }] })], { encoding: 'utf8' });
  const measured = run('measure');
  assert.equal(measured.status, 0, measured.stderr);
  assert.equal(parseWorkerOutput(measured.stdout).cases[0]?.samples.length, 1);
  const verified = run('verify');
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /library check ran/);
});

test('parseWorkerJob requires a verify or measure mode', () => {
  const job = { mode: 'measure', settings: { warmupMs: 0, batchMs: 1, batches: 1, rounds: 1 }, cases: [] };
  assert.deepEqual(parseWorkerJob(JSON.stringify(job)), job);
  for (const mode of [undefined, 'time']) assert.throws(() => parseWorkerJob(JSON.stringify({ ...job, mode })), /worker job/);
});
