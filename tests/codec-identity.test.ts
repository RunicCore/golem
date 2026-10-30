import assert from 'node:assert/strict';
import test from 'node:test';
import { codecPublicId } from '@exprtlabs/golem/internal/schema-graph';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';

const shape: ModelTypeDescriptor = {
  kind: 'object',
  properties: { id: { kind: 'string' } },
  required: ['id'],
  additionalProperties: false,
};

test('the same shape gets different ids for a plain object and a class', () => {
  assert.notEqual(
    codecPublicId('Payment', shape, undefined, { source: 'typescript', constructs: false }),
    codecPublicId('Payment', shape, undefined, { source: 'typescript', constructs: true }),
  );
});

test('the same shape gets different ids from TypeScript and OpenAPI sources', () => {
  assert.notEqual(
    codecPublicId('Payment', shape, undefined, { source: 'typescript', constructs: true }),
    codecPublicId('Payment', shape, undefined, { source: 'openapi', constructs: true }),
  );
});
