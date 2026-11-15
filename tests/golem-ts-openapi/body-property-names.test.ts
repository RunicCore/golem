import assert from 'node:assert/strict';
import test from 'node:test';
import { propertyNames } from '#ts-openapi/operations';

// protects: T-937 the names of a body part that names itself through allOf end without a loop; each reference resolves to a fresh object, as in the generator
test('the property names of a schema that names itself through allOf are read once', () => {
  const components: Record<string, () => Record<string, unknown>> = {
    '#/components/schemas/Self': () => ({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'], allOf: [{ $ref: '#/components/schemas/Self' }] }),
    '#/components/schemas/Ping': () => ({ properties: { a: {} }, allOf: [{ $ref: '#/components/schemas/Pong' }] }),
    '#/components/schemas/Pong': () => ({ properties: { b: {} }, allOf: [{ $ref: '#/components/schemas/Ping' }] }),
  };
  const resolve = (reference: string) => components[reference]?.();
  assert.deepEqual([...propertyNames(resolve, { $ref: '#/components/schemas/Self' }, 'properties') ?? []], ['id']);
  assert.deepEqual([...propertyNames(resolve, { $ref: '#/components/schemas/Self' }, 'required') ?? []], ['id']);
  assert.deepEqual([...propertyNames(resolve, { $ref: '#/components/schemas/Ping' }, 'properties') ?? []].sort(), ['a', 'b']);
});

test('the property names of a part are undefined when a part cannot be read', () => {
  assert.equal(propertyNames(() => undefined, { $ref: '#/components/schemas/Gone' }, 'required'), undefined);
  assert.equal(propertyNames(() => undefined, { allOf: [{ $ref: '#/components/schemas/Gone' }] }, 'required'), undefined);
});
