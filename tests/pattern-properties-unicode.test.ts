import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { instantiateRuntime, emitCodecRuntimeText } from './emitted-runtime.js';

/** A map whose keys are matched by two patterns that need the `u` flag, each with a date-time value. */
function datesByKeyGraph(): ReturnType<typeof createSchemaGraph> {
  const dates: ModelTypeDescriptor = {
    kind: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
    constraints: [
      { kind: 'patternProperties', pattern: '^\\p{L}+$', schema: { kind: 'date' } },
      { kind: 'patternProperties', pattern: '^\\u{1F600}$', schema: { kind: 'date' } },
    ],
  };
  const graph = createSchemaGraph();
  graph.intern(dates, 'DatesByKey', true);
  graph.seal();
  return graph;
}

test('a patternProperties key that only the u flag matches decodes to its declared type', () => {
  // protects: T-483 the generated conversion matches Unicode keys like the validator
  const runtime = instantiateRuntime(emitCodecRuntimeText(datesByKeyGraph(), { validationEnabled: false }));
  const wire = { 'é': '1970-01-01T00:00:00.000Z', '\u{1F600}': '1970-01-01T00:00:01.000Z', ascii: '1970-01-01T00:00:02.000Z' };
  const decoded = runtime.fromWireFormatDatesByKey(wire, { validate: false }) as Record<string, unknown>;
  assert.deepEqual(decoded, {
    'é': new Date(0),
    '\u{1F600}': new Date(1000),
    ascii: new Date(2000),
  });
});
