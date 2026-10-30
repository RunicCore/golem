import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAndValidate } from '#openapi/document';
import { operationHasCodecs } from '#openapi/model-emission';
import { analyzeOpenApiModels } from '#openapi/model-schema-graph';

// An inbound operation has codecs when the SDK validates it or converts one of its values: the rule the golem mode asks of the builder of the standalone mode.

function hasCodecs(parameters: readonly object[], validates: boolean): boolean {
  const document = {
    openapi: '3.2.0',
    info: { title: 'Hooks', version: '1' },
    webhooks: { hook: { post: { operationId: 'receive', parameters, responses: { 204: { description: 'No content' } } } } },
  };
  const { operations, inboundOperations } = normalizeAndValidate(document);
  const analysis = analyzeOpenApiModels(document, validates, 'date', [...operations, ...inboundOperations]);
  return operationHasCodecs(inboundOperations[0]!, analysis, validates);
}

for (const [name, parameters, validates, expected] of [
  ['an SDK that does not validate and an operation that converts nothing', [{ name: 'tenant', in: 'query', schema: { type: 'string' } }], false, false],
  ['an SDK that does not validate and an operation with a date', [{ name: 'X-Sent', in: 'header', schema: { type: 'string', format: 'date-time' } }], false, true],
  ['an SDK that validates and an operation that converts nothing', [{ name: 'tenant', in: 'query', schema: { type: 'string' } }], true, true],
] as const) {
  test(`an inbound operation has codecs: ${name}`, () => {
    // protects: T-748 T-750 one rule decides whether an operation has codecs in both modes
    assert.equal(hasCodecs(parameters, validates), expected);
  });
}
