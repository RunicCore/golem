import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { writeSdk } from '#openapi/generator';
import {
  artifactBasenames,
  compileGeneratedSdk,
  generateMaterializedSdk,
  generatedModelSource,
} from './openapi/helpers.js';

function standaloneDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Standalone', version: '1' },
    paths: {
      '/tasks': {
        post: {
          operationId: 'createTask',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } },
          },
          responses: {
            201: {
              description: 'created',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } },
            },
            400: {
              description: 'problem',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } },
            },
          },
        },
      },
      '/tasks/{id}': {
        get: {
          operationId: 'getTask',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Task' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Child: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        Task: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'when', 'child', 'labels'],
          properties: {
            id: { type: 'string' },
            when: { type: 'string', format: 'date-time' },
            child: { $ref: '#/components/schemas/Child' },
            labels: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
          },
        },
        Problem: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'message'],
          properties: { code: { type: 'string' }, message: { type: 'string' } },
        },
      },
    },
  };
}

const profile = Object.freeze({
  mobx: false,
  validation: true,
  allowAny: false,
});

function compileStandaloneSdk(output: string): string {
  const outDir = path.join(output, 'dist');
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir });
  return outDir;
}

test('OpenAPI SDKs emit per-operation validators; models use generated validators', () => {
  const result = writeSdk(standaloneDocument(), {
    output: path.join(tmpdir(), 'validators-profile'),
    name: 'Standalone',
    profile,
  });
  const names = artifactBasenames(result.artifacts);
  assert.equal(names.includes('getTask.validators.generated.ts'), true);
  const models = generatedModelSource(result.artifacts);
  assert.match(models, /validators\.generated\.js/);
  assert.match(models, /createObjectCodec/);
  const manifest = JSON.parse(result.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as {
    profile?: { allowAny?: boolean };
  };
  assert.equal(manifest.profile?.allowAny, false);
});

test('standalone SDK compiles a no-content operation with no response validators', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'golem-openapi-no-content-'));
  const output = path.join(directory, 'sdk');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await generateMaterializedSdk({
    openapi: '3.1.0',
    info: { title: 'No content', version: '1' },
    paths: {
      '/tasks/{id}': {
        delete: {
          operationId: 'deleteTask',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 204: { description: 'deleted' } },
        },
      },
    },
  }, { output, name: 'NoContent', profile });
  const operation = result.artifacts.find(artifact => artifact.path.endsWith('/operations/deleteTask.ts'));
  assert.ok(operation);
  assert.match(operation.content, /responseReferences: \[\]/);
  assert.doesNotMatch(operation.content, /for \(const item of \[\]/);
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
});

test('SDK operation validators expose every operation reference and validate through the client', async t => {
  const output = path.join(mkdtempSync(path.join(tmpdir(), 'golem-openapi-standalone-')), 'sdk');
  t.after(() => rmSync(path.dirname(output), { recursive: true, force: true }));
  const result = await generateMaterializedSdk(standaloneDocument(), {
    output,
    name: 'Standalone',
    profile,
  });
  const compiled = compileStandaloneSdk(output);
  const operationModules = ['createTask', 'getTask'];
  for (const operation of operationModules) {
    const generatedCode = readFileSync(path.join(output, `operations/${operation}.validators.generated.ts`), 'utf8');
    assert.doesNotMatch(generatedCode, /new\s+Function|\beval\s*\(/);
  }
  assert.ok(result.artifacts.some(item => /\/models\/_[^/]*\.validators\.generated\.ts$/.test(item.path)), 'model groups carry their own validators');

  type OperationValidator = (value: unknown, all: boolean) => readonly { readonly path: readonly unknown[] }[];
  const suffix = (reference: string, operation: string): string => reference.slice(reference.indexOf(`:operation:${operation}:`) + `:operation:${operation}:`.length);
  const expected: Record<string, string[]> = {
    createTask: ['input', 'response:201:application%2Fjson', 'response:400:application%2Fjson'],
    getTask: ['input', 'response:200:application%2Fjson'],
  };
  const task = { id: 'task-1', when: '2025-01-02T03:04:05Z', child: { id: 'child-1' }, labels: ['one'] };
  const validatorsOf = async (operation: string): Promise<Record<string, OperationValidator>> => {
    const module = await import(pathToFileURL(path.join(compiled, `operations/${operation}.validators.generated.js`)).href);
    return module.validators as Record<string, OperationValidator>;
  };
  for (const operation of operationModules) {
    const validators = await validatorsOf(operation);
    assert.deepEqual(Object.keys(validators).map(reference => suffix(reference, operation)).sort(), [...expected[operation] ?? []].sort(), `${operation} validators`);
    for (const reference of Object.keys(validators)) assert.equal(typeof validators[reference], 'function', reference);
  }

  const created = await validatorsOf('createTask');
  const inputReference = Object.keys(created).find(reference => suffix(reference, 'createTask') === 'input') ?? '';
  const inputValidator = created[inputReference];
  assert.ok(inputValidator);
  assert.deepEqual(inputValidator({ body: task }, true), []);
  assert.deepEqual(inputValidator({ body: { ...task, labels: [] } }, true).map(issue => issue.path), [['body', 'labels']]);
  assert.deepEqual(inputValidator({ body: { ...task, when: 'not-a-date' } }, true).map(issue => issue.path), [['body', 'when']]);

  const clientModule = await import(pathToFileURL(path.join(compiled, 'client.js')).href);
  const respond = (status: number, body: unknown): typeof fetch => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const createdTask = await new clientModule.StandaloneClient({ baseUrl: 'https://api.example', fetchImpl: respond(201, task) })
    .createTask().execute({ body: task });
  assert.deepEqual(createdTask.body, task);
  const fetched = await new clientModule.StandaloneClient({ baseUrl: 'https://api.example', fetchImpl: respond(200, task) })
    .getTask().execute({ path: { id: 'task-1' } });
  assert.deepEqual(fetched.body, task);
  await assert.rejects(
    () => new clientModule.StandaloneClient({ baseUrl: 'https://api.example', fetchImpl: respond(201, task) })
      .createTask().execute({ body: { ...task, labels: [] } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation,
  );
});

test('standalone SDK validates a response whose $id schema refers to a component by local pointer', async t => {
  const output = path.join(mkdtempSync(path.join(tmpdir(), 'golem-openapi-embedded-id-')), 'sdk');
  t.after(() => rmSync(path.dirname(output), { recursive: true, force: true }));
  await generateMaterializedSdk({
    openapi: '3.1.0',
    info: { title: 'Fixture', version: '1' },
    paths: {
      '/embedded': {
        get: {
          operationId: 'getEmbedded',
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: 'urn:fixture:embedded' } } } } },
        },
      },
    },
    components: {
      schemas: {
        Child: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'integer' }, serverValue: { type: 'string', readOnly: true } },
        },
        Embedded: {
          $id: 'urn:fixture:embedded',
          type: 'object',
          additionalProperties: false,
          required: ['code', 'child'],
          properties: { code: { type: 'string' }, child: { $ref: '#/components/schemas/Child' } },
        },
      },
    },
  }, { output, name: 'Fixture', profile });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
  const { FixtureClient } = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const call = (body: unknown) => new FixtureClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  }).getEmbedded().execute({});
  assert.deepEqual((await call({ code: 'c', child: { value: 1 } })).body, { code: 'c', child: { value: 1 } });
  await assert.rejects(
    () => call({ code: 'c', child: { value: 'one' } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation,
  );
});
