import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generate, loadValidatedDocument } from '#openapi/generator';
import { createFixtureProject } from '../fixture-project.js';

function write(directory: string, name: string, value: unknown): string {
  const filename = path.join(directory, name);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
  return filename;
}

const profile = { mobx: false, validation: false };

test('multi-file documents generate with path-based model names and watch every file', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-generate-');
  write(directory, 'paths/users.yaml', [
    'get:',
    '  operationId: listUsers',
    '  responses:',
    "    '200':",
    '      description: ok',
    '      content:',
    '        application/json:',
    "          schema: { type: array, items: { $ref: '../schemas/user.json' } }",
    '',
  ].join('\n'));
  write(directory, 'schemas/user.json', { type: 'object', required: ['id'], properties: { id: { type: 'string' } } });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'External', version: '1' },
    paths: { '/users': { $ref: './paths/users.yaml' } },
  });
  const result = await generate({ input, output: path.join(directory, 'sdk'), name: 'External', profile });
  const types = result.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
  assert.match(types, /SchemasUser/);
  const client = result.artifacts.find((artifact) => artifact.path.endsWith('/client.ts'))?.content ?? '';
  assert.match(client, /listUsers/);
  assert.deepEqual(result.watchInputs, [input, path.join(directory, 'paths/users.yaml'), path.join(directory, 'schemas/user.json')].sort());
});

test('validation errors point at the file that contains the problem', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-location-');
  write(directory, 'schemas/bad.json', { type: 'strng' });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Bad', version: '1' },
    components: { schemas: { Bad: { $ref: './schemas/bad.json' } } },
  });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    /OpenAPI validation failed with 1 error\(s\):\nschema: must be equal to one of the allowed values \(schemas\/bad\.json#\/type\)/,
  );
});

test('an unresolved pointer into another file is reported at the ref', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-unresolved-');
  write(directory, 'params.json', { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Missing', version: '1' },
    paths: { '/a': { get: { parameters: [{ $ref: './params.json#/Nope' }], responses: { 200: { description: 'ok' } } } } },
  });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    /no-unresolved-refs: Can't resolve \$ref \.\/params\.json#\/Nope \(api\.json#\/paths\/~1a\/get\/parameters\/0\/\$ref\)/,
  );
});

test('a root ref to an $id declared in a local file resolves without remote access', async (t) => {
  for (const id of ['https://schemas.example/money', 'urn:example:money']) {
    const directory = createFixtureProject(t, 'golem-external-id-');
    write(directory, 'money.json', {
      $id: id,
      type: 'object',
      required: ['currency'],
      properties: { currency: { type: 'string' } },
    });
    const input = write(directory, 'api.json', {
      openapi: '3.1.0',
      info: { title: 'Identity', version: '1' },
      components: {
        schemas: {
          Money: { $ref: './money.json' },
          Price: { type: 'object', properties: { amount: { $ref: id } } },
        },
      },
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
    try {
      const result = await generate({ input, output: path.join(directory, 'sdk'), profile });
      const types = result.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
      assert.match(types, /amount\?: Money/, id);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('a problem that names a second location reports it in the file that contains it', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-related-');
  write(directory, 'a.json', { get: { operationId: 'dup', responses: { 200: { description: 'ok' } } } });
  const input = write(directory, 'api.json', {
    openapi: '3.1.0',
    info: { title: 'Related', version: '1' },
    paths: {
      '/a': { $ref: './a.json' },
      '/b': { get: { operationId: 'dup', responses: { 200: { description: 'ok' } } } },
    },
  });
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'OpenAPI validation failed with 1 error(s):\n'
          + 'operation-operationId-unique: operationId "dup" is used more than once (also at a.json#/get/operationId) (api.json#/paths/~1b/get/operationId)',
      );
      return true;
    },
  );
});

test('a 3.2 media type in another file is expanded in place in the loaded document', async (t) => {
  const directory = createFixtureProject(t, 'golem-external-media-type-');
  write(directory, 'media.json', { schema: { type: 'string' } });
  const input = write(directory, 'api.json', {
    openapi: '3.2.0',
    info: { title: 'Media', version: '1' },
    paths: { '/a': { get: { operationId: 'getA', responses: { 200: { description: 'ok', content: { 'application/json': { $ref: './media.json' } } } } } } },
  });
  const document = await loadValidatedDocument(input);
  assert.deepEqual(Reflect.get(Object(document), 'paths'), {
    '/a': { get: { operationId: 'getA', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } } } } },
  });
  assert.deepEqual(Reflect.get(Object(document), 'components'), { mediaTypes: { media: { schema: { type: 'string' } } } });
  const result = await generate({ input, output: path.join(directory, 'sdk'), profile });
  const client = result.artifacts.find((artifact) => artifact.path.endsWith('/client.ts'))?.content ?? '';
  assert.match(client, /getA/);
});
