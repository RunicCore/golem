import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkerJob, parseWorkerOutput } from '../scripts/benchmark/worker-protocol.js';

const settings = { warmupMs: 300, batchMs: 200, batches: 5 };

test('parseWorkerJob accepts a job and rejects malformed input', () => {
  const job = { settings, cases: [{ fixture: 'ObjectSimple', operation: 'validate' }] };
  assert.deepEqual(parseWorkerJob(JSON.stringify(job)), job);
  for (const broken of ['not json', '{}', JSON.stringify({ settings, cases: [{ fixture: 'x', operation: 'delete' }] }), JSON.stringify({ settings: { warmupMs: 1 }, cases: [] })]) {
    assert.throws(() => parseWorkerJob(broken), /worker job/i, broken);
  }
});

test('parseWorkerOutput accepts output and rejects malformed input', () => {
  const output = { fixtureAdapter: 'zod', checksum: 7, cases: [{ fixture: 'ObjectSimple', operation: 'validate', payloadBytes: 10, samples: [{ iterations: 1, elapsedMs: 2 }] }] };
  assert.deepEqual(parseWorkerOutput(JSON.stringify(output)), output);
  for (const broken of ['', '[]', JSON.stringify({ ...output, checksum: 'x' }), JSON.stringify({ ...output, cases: [{ fixture: 'ObjectSimple', operation: 'validate', payloadBytes: 10, samples: [{ iterations: 1 }] }] })]) {
    assert.throws(() => parseWorkerOutput(broken), /worker output/i, broken);
  }
});
