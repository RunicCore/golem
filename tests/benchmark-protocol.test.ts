import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkerOutput } from '../scripts/benchmark/worker-protocol.js';

test('parseWorkerOutput accepts output and rejects malformed input', () => {
  const output = { fixtureAdapter: 'zod', checksum: 7, cases: [{ fixture: 'ObjectSimple', operation: 'validate', payloadBytes: 10, samples: [{ iterations: 1, elapsedMs: 2 }] }] };
  assert.deepEqual(parseWorkerOutput(JSON.stringify(output)), output);
  for (const broken of ['', '[]', JSON.stringify({ ...output, checksum: 'x' }), JSON.stringify({ ...output, cases: [{ fixture: 'ObjectSimple', operation: 'validate', payloadBytes: 10, samples: [{ iterations: 1 }] }] })]) {
    assert.throws(() => parseWorkerOutput(broken), /worker output/i, broken);
  }
});
