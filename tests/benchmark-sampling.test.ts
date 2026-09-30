import assert from 'node:assert/strict';
import test from 'node:test';
import { WARMUP_ROUNDS, sampleAsync, sampleSync, schedule } from '../scripts/benchmark/sampling.js';

test('warmup runs untimed full rotations in the same interleaving as the timed batches', () => {
  const steps = schedule(3, { warmupMs: 300, batchMs: 200, batches: 2 });
  const warm = steps.filter(s => !s.timed);
  const timed = steps.filter(s => s.timed);
  assert.equal(warm.length, 3 * WARMUP_ROUNDS);
  assert.ok(warm.every(s => s.durationMs === 300 / WARMUP_ROUNDS));
  // Every case is warmed once before any case is warmed again.
  assert.deepEqual(new Set(warm.slice(0, 3).map(s => s.index)), new Set([0, 1, 2]));
  assert.ok(steps.findIndex(s => s.timed) === warm.length, 'all warmup precedes timing');
  assert.deepEqual(timed.map(s => s.index), [0, 1, 2, 1, 2, 0]);
  assert.ok(timed.every(s => s.durationMs === 200));
  assert.ok(schedule(2, { warmupMs: 0, batchMs: 1, batches: 1 }).every(s => s.timed), 'no warmup steps when warmupMs is zero');
});

test('sampleSync measures without awaiting and consumes every result', () => {
  let calls = 0;
  const result = sampleSync(() => ++calls, value => Number(value), 5);
  assert.ok(!(result instanceof Promise));
  assert.equal(result.iterations, calls);
  assert.ok(result.iterations > 0 && result.elapsedMs >= 5);
  assert.equal(result.checksum, (calls * (calls + 1) / 2) % 2_147_483_647);
});

test('sampleAsync awaits each call', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await sampleAsync(async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return 1; }, () => 1, 2);
  assert.equal(maxActive, 1);
  assert.ok(result.iterations > 0 && result.checksum === result.iterations);
});
