import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveJsonPointer } from '#openapi/json';
import {
  visitOpenApiComponent,
  visitOpenApiSchemaTree,
  type OpenApiComponentKind,
} from '#openapi/schema-projection';

const document = {
  openapi: '3.2.0',
  info: { title: 'Walker', version: '1' },
  paths: {
    '/a': { $ref: './paths/a.yaml' },
    '/b': {
      parameters: [{ $ref: './p.yaml#/Limit' }],
      post: {
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' }, examples: { e: { $ref: './ex.yaml' } } }],
        requestBody: { $ref: './body.yaml' },
        responses: {
          200: {
            description: 'ok',
            headers: { 'X-Rate': { $ref: './h.yaml' } },
            links: { next: { $ref: './link.yaml' } },
            content: {
              'application/json': {
                schema: { $ref: './s.yaml' },
                examples: { sample: { $ref: './ex2.yaml' } },
                encoding: { part: { headers: { 'X-Part': { $ref: './h2.yaml' } } } },
              },
              'text/plain': { $ref: '#/components/mediaTypes/Text' },
            },
          },
          404: { $ref: './notfound.yaml' },
        },
        callbacks: { onEvent: { $ref: './cb.yaml' } },
      },
    },
  },
  components: {
    securitySchemes: { key: { $ref: './sec.yaml' } },
    mediaTypes: { Text: { schema: { type: 'string' } } },
  },
};

test('every Reference Object site is reported with its component kind', () => {
  const seen: [string, OpenApiComponentKind][] = [];
  const schemaRefs: string[] = [];
  visitOpenApiSchemaTree(document, {
    onOpenApiRef(_reference, pointer, kind) { seen.push([pointer, kind]); },
    onSchemaRef(_keyword, _reference, _base, pointer) { schemaRefs.push(pointer); },
  });
  assert.deepEqual(seen.sort(([a], [b]) => a.localeCompare(b)), [
    ['#/components/securitySchemes/key/$ref', 'securitySchemes'],
    ['#/paths/~1a/$ref', 'pathItems'],
    ['#/paths/~1b/parameters/0/$ref', 'parameters'],
    ['#/paths/~1b/post/callbacks/onEvent/$ref', 'callbacks'],
    ['#/paths/~1b/post/parameters/0/examples/e/$ref', 'examples'],
    ['#/paths/~1b/post/requestBody/$ref', 'requestBodies'],
    ['#/paths/~1b/post/responses/200/content/application~1json/encoding/part/headers/X-Part/$ref', 'headers'],
    ['#/paths/~1b/post/responses/200/content/application~1json/examples/sample/$ref', 'examples'],
    ['#/paths/~1b/post/responses/200/content/text~1plain/$ref', 'mediaTypes'],
    ['#/paths/~1b/post/responses/200/headers/X-Rate/$ref', 'headers'],
    ['#/paths/~1b/post/responses/200/links/next/$ref', 'links'],
    ['#/paths/~1b/post/responses/404/$ref', 'responses'],
  ]);
  assert.deepEqual(schemaRefs, ['#/paths/~1b/post/responses/200/content/application~1json/schema/$ref']);
});

test('visitOpenApiComponent walks a standalone node of the given kind', () => {
  const refs: string[] = [];
  visitOpenApiComponent('schemas', { type: 'object', properties: { a: { $ref: './a.json' } } }, 'file:///x/s.json', '#', {
    onSchemaRef(_keyword, reference, _base, pointer) { refs.push(`${pointer} ${reference}`); },
  });
  visitOpenApiComponent('headers', { schema: { $ref: './h.json' } }, 'file:///x/h.json', '#/Rate', {
    onSchemaRef(_keyword, reference, _base, pointer) { refs.push(`${pointer} ${reference}`); },
  });
  assert.deepEqual(refs, ['#/properties/a/$ref ./a.json', '#/Rate/schema/$ref ./h.json']);
});

test('resolveJsonPointer follows escaped tokens and array indexes, as plain RFC 6901 with no percent-decoding', () => {
  const value = { 'a/b': [{ 'c~d': 1 }] };
  assert.equal(resolveJsonPointer(value, '/a~1b/0/c~0d'), 1);
  assert.equal(resolveJsonPointer(value, ''), value);
  assert.equal(resolveJsonPointer(value, '/missing'), undefined);
  assert.equal(resolveJsonPointer(value, 'no-slash'), undefined);
  assert.equal(resolveJsonPointer({ 'a%20b': 1 }, '/a%20b'), 1);
});

test('visitOpenApiSchemaTree reports discriminator mapping and defaultMapping values with their owner and key', () => {
  const reported: string[] = [];
  visitOpenApiSchemaTree({
    openapi: '3.2.0',
    components: {
      schemas: {
        Pet: {
          $id: 'https://schemas.example/pet',
          oneOf: [{ $ref: './dog.json' }],
          discriminator: { propertyName: 'kind', mapping: { 'a/b': './dog.json', skip: 1 }, defaultMapping: 'Dog' },
        },
      },
    },
  }, {
    onDiscriminatorMapping(keyword, reference, base, ownerPointer, property) {
      reported.push(`${keyword} ${ownerPointer} ${property} ${reference} ${base}`);
    },
  });
  assert.deepEqual(reported, [
    'mapping #/components/schemas/Pet/discriminator/mapping a/b ./dog.json https://schemas.example/pet',
    'defaultMapping #/components/schemas/Pet/discriminator defaultMapping Dog https://schemas.example/pet',
  ]);
});
