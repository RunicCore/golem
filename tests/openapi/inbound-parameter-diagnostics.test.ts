import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import path from 'node:path';
import { generate, writeSdk } from '#openapi/generator';
import { defaultTestProfile, writeOpenApiDocument } from './helpers.js';

// An inbound handler gets the text the framework has already decoded, so a parameter whose items or members can hold the separator of its style
// cannot be read back; generation stops and names the parameter.

const word = { type: 'string' };
const tags = { type: 'array', items: word };
const nested = { type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'integer' } } } } };
const document = (parameter: Record<string, unknown>, ...others: Record<string, unknown>[]) => ({
  openapi: '3.2.0',
  info: { title: 'Hooks', version: '1' },
  components: { schemas: { Tags: tags, Id: { type: 'integer' } } },
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
  ['a tuple of strings in a path', { name: 'tags', in: 'path', required: true, schema: { type: 'array', prefixItems: [word, word] } }, []],
  ['items with no type', { name: 'tags', in: 'query', explode: false, schema: { type: 'array', items: {} } }, []],
  ['items with a rule but no type', { name: 'tags', in: 'query', explode: false, schema: { type: 'array', items: { minLength: 1 } } }, []],
  ['a member with no type', { name: 'tags', in: 'query', explode: false, schema: { type: 'object', properties: { a: { maxLength: 20 } } } }, []],
  ['an item branch with no type', { name: 'tags', in: 'query', explode: false, schema: { type: 'array', items: { anyOf: [{ type: 'integer' }, { minLength: 1 }] } } }, []],
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
  ['items that are a reference with a described sibling', { name: 'ids', in: 'path', required: true, schema: { type: 'array', items: { allOf: [{ $ref: '#/components/schemas/Id' }, { description: 'The id of a tag' }] } } }],
  ['integer items in a matrix path with explode', { name: 'ids', in: 'path', style: 'matrix', explode: true, required: true, schema: { type: 'array', items: { type: 'integer' } } }],
  ['integer items in a joined cookie', { name: 'ids', in: 'cookie', explode: false, schema: { type: 'array', items: { type: 'integer' } } }],
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

const oneOperation = (parameter: Record<string, unknown>) => ({
  openapi: '3.2.0',
  info: { title: 'Things', version: '1' },
  paths: { '/things/{ids}': { get: { operationId: 'list', parameters: [parameter], responses: { 204: { description: 'No content' } } } } },
});

// The document check of the loader refuses these styles for a document it loads; a document handed to the writer directly reaches the style check.
for (const [name, parameter] of [
  ['simple in a query', { name: 'ids', in: 'query', style: 'simple', schema: { type: 'integer' } }],
  ['form in a header', { name: 'X-Ids', in: 'header', style: 'form', schema: { type: 'integer' } }],
  ['form in a path', { name: 'ids', in: 'path', style: 'form', required: true, schema: { type: 'integer' } }],
] as const) {
  test(`generation stops for a parameter style that its place does not have: ${name}`, (t) => {
    // protects: T-751 a style that OpenAPI does not allow at the place is a coded error of the document, not an error at every call
    const directory = createFixtureProject(t, 'golem-openapi-parameter-style-');
    const result = writeSdk(oneOperation(parameter), { output: path.join(directory, 'sdk'), name: 'Things', profile: defaultTestProfile });
    assert.deepEqual(result.diagnostics?.map(({ code }) => code), ['OPENAPI_PARAMETER_STYLE_NOT_ALLOWED']);
    assert.ok(result.diagnostics![0]!.message.includes(`"${parameter.name}"`));
    assert.deepEqual(result.artifacts, []);
  });
}
