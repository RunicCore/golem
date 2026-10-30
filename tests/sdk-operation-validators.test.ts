import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { compileSdkValidators } from '@exprtlabs/golem/internal/validation-plan';
import { writeSdk } from '#openapi/generator';
import {
  artifactBasenames,
  compileGeneratedSdk,
  generateMaterializedSdk,
  sdkBodyCodec,
  withRootOperations,
} from './openapi/helpers.js';
import { createFixtureProject } from './fixture-project.js';
import { openScope, runModule } from './support/run-module.js';

function validatedDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Validated', version: '1' },
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

/** The values a generated TypeScript module exports, with every import stubbed. */
function exportsOf(source: string): Record<string, unknown> {
  const open = openScope();
  const holder = { exports: {} as Record<string, unknown> };
  runModule(source, { require: () => open, exports: holder.exports, module: holder }, { format: 'cjs' });
  return holder.exports;
}

function compileValidatedSdk(output: string): string {
  const outDir = path.join(output, 'dist');
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir });
  return outDir;
}

test('a validating OpenAPI SDK emits one validators module and records the profile in its manifest', () => {
  const result = writeSdk(validatedDocument(), {
    output: path.join(tmpdir(), 'validators-profile'),
    name: 'Validated',
    profile,
  });
  const names = artifactBasenames(result.artifacts);
  assert.equal(names.includes('validators.generated.ts'), true);
  const manifest = JSON.parse(result.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as {
    profile?: { allowAny?: boolean };
  };
  assert.equal(manifest.profile?.allowAny, false);
});

test('SDK compiles a no-content operation with no response validators', async t => {
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
  assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('/operations/deleteTask.ts')));
  const compiled = compileValidatedSdk(output);
  const { NoContentClient } = await import(pathToFileURL(path.join(compiled, 'client.js')).href);
  const deleted = await new NoContentClient({ baseUrl: 'https://api.example', fetchImpl: async () => new Response(null, { status: 204 }) })
    .deleteTask().execute({ path: { id: 'task-1' } });
  assert.equal(deleted.status, 204);
});

test('SDK operations accept a valid body and reject an invalid one through the client', async t => {
  const output = path.join(mkdtempSync(path.join(tmpdir(), 'golem-openapi-validated-')), 'sdk');
  t.after(() => rmSync(path.dirname(output), { recursive: true, force: true }));
  const result = await generateMaterializedSdk(validatedDocument(), {
    output,
    name: 'Validated',
    profile,
  });
  const compiled = compileValidatedSdk(output);
  const generatedCode = readFileSync(path.join(output, 'validators.generated.ts'), 'utf8');
  // protects: security: generated validators contain no eval or new Function (CSP-safe, no dynamic code)
  assert.doesNotMatch(generatedCode, /new\s+Function|\beval\s*\(/);
  assert.ok(result.artifacts.some(item => item.path === path.join(output, 'validators.generated.ts')), 'the SDK carries one validators module');

  const task = { id: 'task-1', when: '2025-01-02T03:04:05Z', child: { id: 'child-1' }, labels: ['one'] };

  const clientModule = await import(pathToFileURL(path.join(compiled, 'client.js')).href);
  const respond = (status: number, body: unknown): typeof fetch => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  // The client takes and returns the converted form: `when` is a Date.
  const plainTask = { ...task, when: new Date('2025-01-02T03:04:05Z') };
  const createdTask = await new clientModule.ValidatedClient({ baseUrl: 'https://api.example', fetchImpl: respond(201, task) })
    .createTask().execute({ body: plainTask });
  assert.deepEqual(createdTask.body, plainTask);
  const fetched = await new clientModule.ValidatedClient({ baseUrl: 'https://api.example', fetchImpl: respond(200, task) })
    .getTask().execute({ path: { id: 'task-1' } });
  assert.deepEqual(fetched.body, plainTask);
  await assert.rejects(
    () => new clientModule.ValidatedClient({ baseUrl: 'https://api.example', fetchImpl: respond(201, task) })
      .createTask().execute({ body: { ...plainTask, labels: [] } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation,
  );
});

const CONVERTING_TASK = withRootOperations({
  openapi: '3.1.0',
  info: { title: 'Converting', version: '1' },
  components: { schemas: { Task: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'labels'],
    properties: { id: { type: 'string' }, labels: { type: 'array', minItems: 1, items: { type: 'string' } }, when: { type: 'string', format: 'date-time' } },
  } } },
}, 'Task');

for (const mode of ['standalone', 'golem'] as const) {
  test(`a ${mode} SDK checks a request body that converts a date like one that converts nothing, and validate false sends it unchecked`, async t => {
    // protects: R-86, T-719 a converting request body is checked at the request level (constraints included), once
    const output = path.join(createFixtureProject(t, `converting-body-${mode}-`), 'sdk');
    await generateMaterializedSdk(CONVERTING_TASK, { output, name: 'Converting', profile, mode });
    compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
    const codec = await sdkBodyCodec(output, 'Converting', 'Task');
    const when = new Date('1970-01-01T00:00:00Z');
    assert.deepEqual(await codec.encode({ id: 'a', labels: ['x'], when }), { id: 'a', labels: ['x'], when: '1970-01-01T00:00:00.000Z' });
    await assert.rejects(
      codec.encode({ id: 'a', labels: [], when }),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === true,
    );
    assert.deepEqual(await codec.encode({ id: 'a', labels: [], when }, { validate: false }), { id: 'a', labels: [], when: '1970-01-01T00:00:00.000Z' });
  });
}

test('SDK validates a response whose $id schema refers to a component by local pointer', async t => {
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

test('a model used in a request and a response with a readOnly field gets two validators that disagree on the field', async t => {
  const output = path.join(mkdtempSync(path.join(tmpdir(), 'golem-openapi-read-only-')), 'sdk');
  t.after(() => rmSync(path.dirname(output), { recursive: true, force: true }));
  const item = { $ref: '#/components/schemas/Item' };
  await generateMaterializedSdk({
    openapi: '3.1.0',
    info: { title: 'Read only', version: '1' },
    paths: {
      '/items': {
        post: {
          operationId: 'createItem',
          requestBody: { required: true, content: { 'application/json': { schema: item } } },
          responses: { 201: { description: 'created', content: { 'application/json': { schema: item } } } },
        },
      },
    },
    components: {
      schemas: {
        Item: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string' }, serverId: { type: 'string', readOnly: true } },
        },
      },
    },
  }, { output, name: 'ReadOnly', profile });
  const compiled = compileValidatedSdk(output);

  type OperationValidator = (value: unknown, all: boolean) => readonly { readonly code: string; readonly path: readonly unknown[] }[];
  const validators = await import(pathToFileURL(path.join(compiled, 'validators.generated.js')).href) as Record<string, OperationValidator>;
  assert.ok(typeof validators.validate_createItem_input === 'function' && typeof validators.validate_createItem_response_201_application_json === 'function');
  // The request and the response plane of the model are separate roots as well; the operation roots differ from them.
  assert.notEqual(validators.validate_createItem_input, validators.validate_createItem_response_201_application_json);
  const withServerId = { name: 'n', serverId: 's' };
  assert.deepEqual(validators.validate_createItem_input({ body: { name: 'n' } }, true), []);
  assert.deepEqual(validators.validate_createItem_input({ body: withServerId }, true).map(issue => [issue.code, issue.path]), [['unknownKey', ['body', 'serverId']]], 'a request may not set the readOnly field');
  assert.deepEqual(validators.validate_createItem_response_201_application_json(withServerId, true), [], 'a response carries the readOnly field');
});

test('a model that only an operation response reads has its check written once in the SDK module, and no root of its own', () => {
  const pattern = '^ITEM-[0-9]{6}$';
  const result = writeSdk({
    openapi: '3.1.0',
    info: { title: 'Shared checks', version: '1' },
    paths: {
      '/items/{id}': {
        get: {
          operationId: 'getItem',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
        },
      },
    },
    components: { schemas: { Item: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern } } } } },
  }, { output: path.join(tmpdir(), 'validators-shared-checks'), name: 'Shared', profile });
  const module = result.artifacts.find(item => path.basename(item.path) === 'validators.generated.ts');
  assert.ok(module);
  // Each check function holds its pattern twice: the compiled expression and the issue it reports.
  assert.equal(module.content.split(JSON.stringify(pattern)).length - 1, 2, 'one check function serves the operation');
  assert.equal(module.content.split('new RegExp(').length - 1, 1, 'one compiled expression');
  const exported = Object.keys(exportsOf(module.content));
  assert.ok(exported.includes('validate_getItem_response_200_application_json'), 'the operation root is exported');
  assert.equal(exported.filter(name => /^validate_Item_[0-9a-f]{8}$/.test(name)).length, 0, 'no group reads the model, so its root is not exported');
});

test('a validation-off SDK writes no validators module and no import of one', () => {
  const result = writeSdk(validatedDocument(), {
    output: path.join(tmpdir(), 'validators-off'),
    name: 'Validated',
    profile: { mobx: false, validation: false, allowAny: false },
  });
  assert.equal(result.artifacts.some(item => item.path.endsWith('validators.generated.ts')), false);
  assert.equal(result.artifacts.some(item => item.content.includes('validators.generated')), false, 'no module imports one');
});

test('an operation root that has the name of a model root fails the SDK compile, and roots that only sanitize alike are numbered', () => {
  const options = { owner: 'test', unknownFormats: 'warn', documentName: 'the document' } as const;
  const plan = { schemas: { 'get-x:input': { type: 'string' } }, references: ['get-x:input'], ownSchemas: ['get-x:input'], modelNames: {} };
  assert.throws(
    () => compileSdkValidators({ plan, operations: [{ roots: { 'get-x:input': { type: 'integer' } }, resources: {} }] }, options),
    /operation root "get-x:input" has the name of another root/,
  );
  const numbered = compileSdkValidators({
    plan,
    operations: [{ roots: { 'get_x_input': { type: 'integer' } }, resources: {} }],
  }, options);
  assert.deepEqual([...numbered.exports.values()].sort(), ['validate_get_x_input', 'validate_get_x_input_2']);
  assert.throws(
    () => compileSdkValidators({ operations: [
      { roots: { a: { type: 'string' } }, resources: { 'urn:shared': { type: 'string' } } },
      { roots: { b: { type: 'string' } }, resources: { 'urn:shared': { type: 'integer' } } },
    ] }, options),
    /two operations give the resource "urn:shared" different schemas/,
  );
});
