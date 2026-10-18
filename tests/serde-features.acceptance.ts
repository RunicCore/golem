import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFeatures } from '../scripts/benchmark/feature-check.js';
import { FEATURE_FIXTURES, MODES, OPERATIONS } from '../scripts/benchmark/fixture-contract.js';

test('Golem feature fixtures pass correctness checks for every operation in every mode', () => {
  const result = checkFeatures();
  assert.deepEqual(result.fixtures, [...FEATURE_FIXTURES]);
  assert.deepEqual(result.modes.map(m => m.mode), [...MODES]);
  for (const mode of result.modes) {
    const operations = mode.mode === 'conversion-only' ? OPERATIONS.filter(o => o !== 'validate') : OPERATIONS;
    assert.ok(mode.checksum > 0, `${mode.mode} must consume results`);
    assert.deepEqual(new Set(mode.cases), new Set(FEATURE_FIXTURES.flatMap(f => operations.map(o => `${f}/${o}`))));
  }
});
