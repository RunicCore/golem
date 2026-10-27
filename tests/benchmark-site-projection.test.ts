import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildBenchmarkSiteProjection } from '../scripts/benchmark/site-projection.js';

// protects: R-30 a corrupt results file stops the docs build before the page shows "NaN B"
test('the docs build stops on a results file whose payload size NaN left as null', () => {
  // The fixture is otherwise valid; its only fault is `"bytes": null`, which is how JSON.stringify writes NaN.
  const workspace = path.resolve(import.meta.dirname, '../..', 'tests/fixtures/benchmark-results-nan-size');
  assert.throws(() => buildBenchmarkSiteProjection(workspace), /scripts\/benchmark\/results\.json is not a valid results file\. Run npm run bench to replace it\./);
});
