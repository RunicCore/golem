import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import path from 'node:path';
import { generateMaterializedSdk } from './helpers.js';

// An inbound handler gets the text the framework has already decoded, so a parameter whose items or members can hold the separator of its style
// cannot be read back; generation stops and names the fix.

const word = { type: 'string' };
const nested = { type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'integer' } } } } };
const document = (parameter: Record<string, unknown>, ...others: Record<string, unknown>[]) => ({
  openapi: '3.2.0',
  info: { title: 'Hooks', version: '1' },
  webhooks: { hook: { post: { operationId: 'receive', parameters: [parameter, ...others], responses: { 204: { description: 'No content' } } } } },
});

for (const [name, parameter, others, reason] of [
  ['string items in a path', { name: 'tags', in: 'path', required: true, schema: { type: 'array', items: word } }, [], /an item can hold ","/],
  ['string items in a joined query', { name: 'tags', in: 'query', explode: false, schema: { type: 'array', items: word } }, [], /an item can hold ","/],
  ['non-integer numbers under label with explode', { name: 'ids', in: 'path', style: 'label', explode: true, required: true, schema: { type: 'array', items: { type: 'number' } } }, [], /an item can hold "\."/],
  ['a string member in a flat object', { name: 'pair', in: 'query', explode: false, schema: { type: 'object', properties: { a: { type: 'integer' }, b: word } } }, [], /a property "b" can hold ","/],
  ['a nested deepObject', { name: 'deep', in: 'query', style: 'deepObject', schema: nested }, [], /a property is an object or an array/],
  ['a free-form deepObject', { name: 'deep', in: 'query', style: 'deepObject', schema: { type: 'object', additionalProperties: { type: 'integer' } } }, [], /properties of its object are not listed/],
  ['a property named like another parameter', { name: 'filter', in: 'query', schema: { type: 'object', properties: { limit: { type: 'integer' } } } }, [{ name: 'limit', in: 'query', schema: { type: 'integer' } }], /its property "limit" is also the name of another query parameter/],
] as const) {
  test(`generation stops for an inbound parameter that cannot be read back: ${name}`, async (t) => {
    // protects: T-747 R-80 F-39 text that could split wrong is refused, never coerced
    const output = path.join(createFixtureProject(t, 'golem-openapi-inbound-ambiguous-'), 'sdk');
    await assert.rejects(generateMaterializedSdk(document(parameter, ...others), { output, name: 'Hooks' }), (error: unknown) => error instanceof Error && /OPENAPI_INBOUND_PARAMETER_AMBIGUOUS/.test(error.message) && reason.test(error.message) && /Set explode/.test(error.message));
  });
}
