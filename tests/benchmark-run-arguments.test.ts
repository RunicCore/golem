import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseArguments } from '../scripts/benchmark/release-check.js';
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
    (error: unknown) => error instanceof BenchmarkUsageError && error.message.startsWith('Unknown payload "bogus". Valid payloads: simple, nested, array, checkout'));
  assert.throws(() => parseRunArguments(['--payloads=']),
    (error: unknown) => error instanceof BenchmarkUsageError && error.message.startsWith('No payload named. Valid payloads: simple, nested, array, checkout'));
});

// protects: T-243 the release check needs a base ref and times golem adapters only
test('the release check reads the base ref beside the filters, and refuses a missing base or a library that is not golem', () => {
  assert.deepEqual(parseReleaseArguments(['--base', '8c842ed', '--adapters=golem-validated', '--payloads', 'simple']), { base: '8c842ed', adapters: ['golem-validated'], payloads: ['simple'] });
  assert.deepEqual(parseReleaseArguments(['--base=main']), { base: 'main' });
  assert.throws(() => parseReleaseArguments(['--adapters', 'golem']), (error: unknown) => error instanceof BenchmarkUsageError && error.message.startsWith('No base ref.'));
  assert.throws(() => parseReleaseArguments(['--base', 'main', '--adapters', 'zod']),
    (error: unknown) => error instanceof BenchmarkUsageError && error.message.startsWith('The release check times golem only; "zod" is not golem.'));
});
