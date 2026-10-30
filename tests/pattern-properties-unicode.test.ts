import assert from 'node:assert/strict';
import test from 'node:test';

import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { code, type StringifySerdeResolver } from '@exprtlabs/golem/internal/emitter';
import { instantiateRuntime, emitCodecRuntimeText } from './emitted-runtime.js';

/** A Date field in the class-value form; only a decode runs here, so the serde converts text to a Date and the wire carries no rule. */
const DATE: ModelTypeDescriptor = { kind: 'class-value', typeName: 'Date', serde: { id: 'date', wire: { kind: 'string' } }, classRef: { path: ['Date'] } };
const DATE_SERDE: StringifySerdeResolver = { serialize: (_id, value) => value, deserialize: (_id, value) => code`new Date(${value} as string)` };

/** A map whose keys are matched by two patterns that need the `u` flag, each with a date-time value. */
function datesByKeyGraph(): ReturnType<typeof createSchemaGraph> {
  const dates: ModelTypeDescriptor = {
    kind: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
    constraints: [
      { kind: 'patternProperties', pattern: '^\\p{L}+$', schema: DATE },
      { kind: 'patternProperties', pattern: '^\\u{1F600}$', schema: DATE },
    ],
  };
  const graph = createSchemaGraph();
  graph.intern(dates, 'DatesByKey', true);
  graph.seal();
  return graph;
}

test('a patternProperties key that only the u flag matches decodes to its declared type', () => {
  // protects: T-483 the generated conversion matches Unicode keys like the validator
  const runtime = instantiateRuntime(emitCodecRuntimeText(datesByKeyGraph(), { validationLevel: false, serde: DATE_SERDE }));
  const wire = { 'é': '1970-01-01T00:00:00.000Z', '\u{1F600}': '1970-01-01T00:00:01.000Z', ascii: '1970-01-01T00:00:02.000Z' };
  const decoded = runtime.fromWireFormatDatesByKey(wire, { validate: false }) as Record<string, unknown>;
  assert.deepEqual(decoded, {
    'é': new Date(0),
    '\u{1F600}': new Date(1000),
    ascii: new Date(2000),
  });
});
