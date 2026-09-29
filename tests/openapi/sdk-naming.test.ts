import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { generate } from '#openapi/generator';
import {
  compileGeneratedSdk,
  documentBase,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
  writeOpenApiDocument,
} from './helpers.js';

test('allows a single Foo-Bar component name and rejects Foo-Bar with Foo.Bar', async (t) => {
  const allowed = createFixtureProject(t, 'runic-openapi-r6-ok-');
  const allowedInput = writeOpenApiDocument(allowed, documentBase('3.1.0', {
    components: {
      schemas: {
        'Foo-Bar': { type: 'object', properties: { value: { type: 'string' } } },
      },
    },
  }));
  const allowedResult = await generate({
    input: allowedInput,
    output: path.join(allowed, 'sdk'),
    profile: { mobx: false, validation: false },
  });
  const types = allowedResult.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
  assert.match(types, /export type FooBar =/);

  const colliding = createFixtureProject(t, 'runic-openapi-r6-collide-');
  const collidingInput = writeOpenApiDocument(colliding, documentBase('3.1.0', {
    components: {
      schemas: {
        'Foo-Bar': { type: 'object', properties: { value: { type: 'string' } } },
        'Foo.Bar': { type: 'object', properties: { other: { type: 'string' } } },
      },
    },
  }));
  await assert.rejects(
    () => generate({
      input: collidingInput,
      output: path.join(colliding, 'sdk'),
      profile: { mobx: false, validation: false },
    }),
    /generated name collision for "FooBar"/,
  );
});

test('rejects operation names that collide with actual client helpers', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-r6-url-');
  const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
    paths: {
      '/url': {
        get: {
          operationId: 'url',
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  }));
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile: { mobx: false, validation: false } }),
    /collides with generated client helper/,
  );
});

test('reserved-word operation names get a deterministic identifier suffix and compile', async t => {
  const reservedDocument = documentBase('3.1.0', {
    paths: {
      '/items': {
        delete: { operationId: 'delete', responses: { 204: { description: 'deleted' } } },
        post: { operationId: 'new', responses: { 204: { description: 'created' } } },
        put: { operationId: 'import', responses: { 204: { description: 'imported' } } },
      },
      // Client class members are reserved like keywords.
      '/members': {
        get: { operationId: 'constructor', responses: { 204: { description: 'read' } } },
        patch: { operationId: 'runtime', responses: { 204: { description: 'patched' } } },
      },
    },
  });
  const rootDeleteDocument = documentBase('3.1.0', {
    paths: { '/': { delete: { responses: { 204: { description: 'deleted' } } } } },
  });
  for (const [document, expected] of [
    [reservedDocument, ['delete_', 'new_', 'import_', 'constructor_', 'runtime_']],
    [rootDeleteDocument, ['delete_']],
  ] as const) {
    for (const profile of [{ mobx: false, validation: false }, { mobx: true, validation: true }]) {
      const directory = createFixtureProject(t, 'runic-openapi-reserved-operation-');
      const output = path.join(directory, 'sdk');
      const result = await generateMaterializedSdk(document, { output, name: 'Reserved', profile });
      compileGeneratedSdk(output);
      const client = requireRecord(await import(pathToFileURL(path.join(output, 'dist/client.js')).href), 'reserved client');
      const ReservedClient = client.ReservedClient;
      if (!isGeneratedClientClass(ReservedClient)) throw new TypeError('ReservedClient must be a class');
      const instance = new ReservedClient({ baseUrl: 'https://example.test', fetchImpl: async () => new Response(null, { status: 204 }) });
      for (const name of expected) {
        const response = await instance[name]().execute({});
        assert.equal(response.status, 204);
      }
      assert.deepEqual(
        (result.diagnostics ?? []).map(diagnostic => diagnostic.severity),
        expected.map(() => 'warning'),
      );
      for (const name of expected) {
        assert.ok(
          (result.diagnostics ?? []).some(diagnostic => diagnostic.message.includes(`"${name}"`)),
          JSON.stringify(result.diagnostics),
        );
      }
    }
  }
});

test('an allocated operation name collision names both sources and the requested name', async t => {
  const directory = createFixtureProject(t, 'runic-openapi-allocated-collision-');
  const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
    paths: {
      '/a': { get: { operationId: 'delete', responses: { 204: { description: 'ok' } } } },
      '/b': { get: { operationId: 'delete_', responses: { 204: { description: 'ok' } } } },
    },
  }));
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile: { mobx: false, validation: false } }),
    /duplicate generated operation name "delete_" for GET \/b; GET \/a \(allocated from "delete"\) already uses it/,
  );
});

test('components named Array and Blob do not shadow generated global types', async t => {
  const directory = createFixtureProject(t, 'runic-openapi-global-shadow-');
  const output = path.join(directory, 'sdk');
  await generateMaterializedSdk(documentBase('3.1.0', {
    paths: {
      '/file': {
        get: {
          operationId: 'getFile',
          responses: { 200: { description: 'ok', content: { 'application/octet-stream': {} } } },
        },
      },
    },
    components: {
      schemas: {
        Array: { type: 'array', items: { type: 'string' } },
        Blob: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        Holder: {
          type: 'object',
          required: ['lists', 'file'],
          properties: {
            lists: { type: 'array', items: { $ref: '#/components/schemas/Array' } },
            file: { type: 'string', format: 'binary' },
            blob: { $ref: '#/components/schemas/Blob' },
          },
        },
      },
    },
  }), { output, name: 'Shadow', profile: { mobx: false, validation: true } });
  const consumer = path.join(output, 'shadow-consumer.ts');
  writeFileSync(consumer, [
    "import type { Blob as BlobComponent, GetFileOperationSuccessBody, Holder } from './types.js';",
    "export const holder: Holder = { lists: [['a']], file: new Blob(['x']), blob: { id: 'b' } };",
    "export const component: BlobComponent = { id: 'c' };",
    "export const body: GetFileOperationSuccessBody = new Blob(['x']);",
    '',
  ].join('\n'));
  compileGeneratedSdk(output, [consumer], { strict: true });
});

test('operation module names that differ only by case are rejected', async t => {
  const directory = createFixtureProject(t, 'runic-openapi-case-operation-');
  const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
    paths: {
      '/a': { get: { operationId: 'getURL', responses: { 204: { description: 'ok' } } } },
      '/b': { get: { operationId: 'getUrl', responses: { 204: { description: 'ok' } } } },
    },
  }));
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile: { mobx: false, validation: false } }),
    /"operations\/getURL\.ts" and "operations\/getUrl\.ts" differ only by letter case/,
  );
});
