import assert from 'node:assert/strict';
import test from 'node:test';
import { BenchmarkUsageError, parseRunArguments } from '../scripts/benchmark/run.js';

// protects: T-234 --payloads filter beside --adapters, usage error for an unknown id
test('the benchmark runs the adapters and payloads it is given, in table order', () => {
  assert.deepEqual(parseRunArguments(['--adapters', 'golem-object-off,golem-object', '--payloads', 'checkout,simple']), {
    adapters: ['golem-object', 'golem-object-off'],
    payloads: ['simple', 'checkout'],
  });
  assert.deepEqual(parseRunArguments(['--payloads=nested']), { payloads: ['nested'] });
  assert.deepEqual(parseRunArguments([]), {});
});

test('the benchmark refuses a payload no case has, and names the payloads it has', () => {
  assert.throws(() => parseRunArguments(['--payloads', 'simple,bogus']),
    (error: unknown) => error instanceof BenchmarkUsageError && error.message === 'Unknown payload "bogus". Valid payloads: simple, nested, array, checkout');
  assert.throws(() => parseRunArguments(['--payloads=']),
    (error: unknown) => error instanceof BenchmarkUsageError && error.message === 'No payload named. Valid payloads: simple, nested, array, checkout');
});
