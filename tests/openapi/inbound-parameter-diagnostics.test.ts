import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import path from 'node:path';
import { generate } from '#openapi/generator';
import { defaultTestProfile, writeOpenApiDocument } from './helpers.js';

// An inbound handler gets the text the framework has already decoded, so a parameter whose items or members can hold the separator of its style
// cannot be read back; generation stops and names the parameter.

const word = { type: 'string' };
const tags = { type: 'array', items: word };
const nested = { type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'integer' } } } } };
const document = (parameter: Record<string, unknown>, ...others: Record<string, unknown>[]) => ({
  openapi: '3.2.0',
  info: { title: 'Hooks', version: '1' },
  components: { schemas: { Tags: tags } },
  webhooks: { hook: { post: { operationId: 'receive', parameters: [parameter, ...others], responses: { 204: { description: 'No content' } } } } },
});

for (const [name, parameter, others] of [
  ['string items in a path', { name: 'tags', in: 'path', required: true, schema: tags }, []],
  ['string items in a joined query', { name: 'tags', in: 'query', explode: false, schema: tags }, []],
  ['string items in a nullable reference to an array', { name: 'tags', in: 'path', required: true, schema: { anyOf: [{ $ref: '#/components/schemas/Tags' }, { type: 'null' }] } }, []],
  ['string items in a matrix path with explode', { name: 'tags', in: 'path', style: 'matrix', explode: true, required: true, schema: tags }, []],
  ['items of a cookie that repeats its name', { name: 'tags', in: 'cookie', schema: { type: 'array', items: { type: 'integer' } } }, []],
  ['non-integer numbers under label with explode', { name: 'tags', in: 'path', style: 'label', explode: true, required: true, schema: { type: 'array', items: { type: 'number' } } }, []],
  ['a string member in a flat object', { name: 'tags', in: 'query', explode: false, schema: { type: 'object', properties: { a: { type: 'integer' }, b: word } } }, []],
  ['a member named with the separator', { name: 'tags', in: 'query', explode: false, schema: { type: 'object', properties: { 'a,b': { type: 'integer' } } } }, []],
  ['a nested deepObject', { name: 'tags', in: 'query', style: 'deepObject', schema: nested }, []],
  ['a free-form deepObject', { name: 'tags', in: 'query', style: 'deepObject', schema: { type: 'object', additionalProperties: { type: 'integer' } } }, []],
  ['a property named like another parameter', { name: 'tags', in: 'query', schema: { type: 'object', properties: { limit: { type: 'integer' } } } }, [{ name: 'limit', in: 'query', schema: { type: 'integer' } }]],
] as const) {
  test(`generation stops for an inbound parameter that cannot be read back: ${name}`, async (t) => {
    // protects: T-747 T-750 R-80 F-39 text that could split wrong is refused, never coerced
    const directory = createFixtureProject(t, 'golem-openapi-inbound-ambiguous-');
    const result = await generate({ input: writeOpenApiDocument(directory, document(parameter, ...others)), output: path.join(directory, 'sdk'), name: 'Hooks', profile: defaultTestProfile });
    assert.deepEqual(result.diagnostics?.map(({ code }) => code), ['OPENAPI_INBOUND_PARAMETER_AMBIGUOUS']);
    assert.ok(result.diagnostics![0]!.message.includes('"tags"'));
    assert.deepEqual(result.artifacts, []);
  });
}

for (const [name, parameter] of [
  ['integer items in a path', { name: 'ids', in: 'path', required: true, schema: { type: 'array', items: { type: 'integer' } } }],
  ['string items from a fixed set in a path', { name: 'ids', in: 'path', required: true, schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }],
  ['string items in a header, which has no escaping', { name: 'X-Ids', in: 'header', schema: tags }],
  ['string items in a repeated query', { name: 'ids', in: 'query', schema: tags }],
  ['a keyed object whose value holds a sign "="', { name: 'pair', in: 'path', required: true, explode: true, schema: { type: 'object', properties: { a: { type: 'string', enum: ['x=y'] } } } }],
] as const) {
  test(`generation goes on for an inbound parameter that reads back: ${name}`, async (t) => {
    // protects: T-750 only a parameter that cannot be read back is refused
    const directory = createFixtureProject(t, 'golem-openapi-inbound-readable-');
    const result = await generate({ input: writeOpenApiDocument(directory, document(parameter)), output: path.join(directory, 'sdk'), name: 'Hooks', profile: defaultTestProfile });
    assert.deepEqual(result.diagnostics ?? [], []);
  });
}
