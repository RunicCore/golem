import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createOpenApiAjvEngine } from '@exprtlabs/golem/ajv';
import { compileStandaloneValidatorSet } from '@exprtlabs/golem/ajv-tooling';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { writeSdk } from '#openapi/generator';
import {
  artifactBasenames,
  compileGeneratedSdk,
  generateMaterializedSdk,
  generatedModelSource,
} from './openapi/helpers.js';

interface GeneratedValidator {
  (value: unknown): boolean;
  readonly errors?: readonly { readonly keyword?: string; readonly message?: string }[] | null;
}

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
  ajvStandalone: true,
  allowAny: false,
});

function compileStandaloneSdk(output: string): string {
  const outDir = path.join(output, 'dist');
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir });
  return outDir;
}

test('OpenAPI standalone profile emits per-operation validators; models always use generated validators', () => {
  const document = standaloneDocument();
  const runtime = writeSdk(document, {
    output: path.join(tmpdir(), 'runtime-profile'),
    name: 'Standalone',
    profile: { mobx: false, validation: true },
  });
  const standalone = writeSdk(document, {
    output: path.join(tmpdir(), 'standalone-profile'),
    name: 'Standalone',
    profile,
  });

  const runtimeNames = artifactBasenames(runtime.artifacts);
  for (const name of ['getTask.validators.generated.js', 'getTask.validators.generated.d.ts', 'getTask.validators.generated.NOTICES.txt']) {
    assert.equal(runtimeNames.includes(name), false, name);
  }
  // Models validate with generated validators whichever Ajv mode the client uses.
  assert.match(generatedModelSource(runtime.artifacts), /validators\.generated\.js/);
  const runtimeManifest = JSON.parse(runtime.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as {
    profile?: { ajvStandalone?: boolean; allowAny?: boolean };
  };
  assert.equal(runtimeManifest.profile?.ajvStandalone, false);
  assert.equal(runtimeManifest.profile?.allowAny, false);

  const standaloneNames = artifactBasenames(standalone.artifacts);
  for (const name of ['getTask.validators.generated.js', 'getTask.validators.generated.d.ts', 'getTask.validators.generated.NOTICES.txt']) {
    assert.equal(standaloneNames.includes(name), true, name);
  }
  // One validator module per operation and model group; no SDK-wide registry, validator module or engine.
  for (const name of ['schemas.ts', 'validators.generated.js', 'validators.generated.d.ts', 'validators.generated.NOTICES.txt', 'validation-engine.ts']) {
    assert.equal(standaloneNames.includes(name), false, name);
  }
  const standaloneModels = generatedModelSource(standalone.artifacts);
  assert.match(standaloneModels, /validators\.generated\.js/);
  assert.match(standaloneModels, /createObjectCodec/);
  assert.doesNotMatch(standaloneModels, /@exprtlabs\/golem\/ajv|createOpenApi(?:Sync)?AjvEngine/);
  const standaloneManifest = JSON.parse(standalone.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as {
    profile?: { ajvStandalone?: boolean; allowAny?: boolean };
  };
  assert.equal(standaloneManifest.profile?.ajvStandalone, true);
  assert.equal(standaloneManifest.profile?.allowAny, false);
  const notices = standalone.artifacts.find(item => item.path.endsWith('/operations/getTask.validators.generated.NOTICES.txt'))?.content ?? '';
  assert.match(notices, /ajv/);
  assert.match(notices, /ajv-formats/);
  assert.match(notices, /fast-deep-equal/);
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

test('standalone SDK compiles with its generated JavaScript, exposes every operation reference, and validates through its client', async t => {
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
    const generatedCode = readFileSync(path.join(output, `operations/${operation}.validators.generated.js`), 'utf8');
    assert.doesNotMatch(generatedCode, /(?:from|require\s*\()\s*['"](?:ajv|ajv-formats|fast-deep-equal)/);
    assert.doesNotMatch(generatedCode, /new\s+Function|\beval\s*\(/);
    assert.match(readFileSync(path.join(output, `operations/${operation}.validators.generated.NOTICES.txt`), 'utf8'), /ajv/);
    assert.ok(result.artifacts.some(item => item.path.endsWith(`/operations/${operation}.validators.generated.d.ts`)));
  }
  assert.ok(result.artifacts.some(item => /\/models\/_[^/]*\.validators\.generated\.ts$/.test(item.path)), 'model groups carry their own validators');

  const fragment = (reference: string): string => reference.slice(reference.indexOf('#'));
  const expected: Record<string, string[]> = {
    createTask: ['#/operations/createTask/input', '#/operations/createTask/responses/201/application~1json', '#/operations/createTask/responses/400/application~1json'],
    getTask: ['#/operations/getTask/input', '#/operations/getTask/responses/200/application~1json'],
  };
  const task = { id: 'task-1', when: '2025-01-02T03:04:05Z', child: { id: 'child-1' }, labels: ['one'] };
  for (const operation of operationModules) {
    const module = await import(pathToFileURL(path.join(compiled, `operations/${operation}.validators.generated.js`)).href);
    const set = module.createValidatorSet() as { first: Record<string, GeneratedValidator>; all: Record<string, GeneratedValidator> };
    assert.deepEqual(Object.keys(set.first).map(fragment).sort(), [...expected[operation] ?? []].sort(), `${operation} first-error validators`);
    assert.deepEqual(Object.keys(set.all).sort(), Object.keys(set.first).sort(), `${operation} all-error validators`);
    for (const reference of Object.keys(set.first)) assert.equal(typeof set.first[reference], 'function', reference);
  }

  const createModule = await import(pathToFileURL(path.join(compiled, 'operations/createTask.validators.generated.js')).href);
  const created = createModule.createValidatorSet().first as Record<string, GeneratedValidator>;
  const inputReference = Object.keys(created).find(reference => fragment(reference) === '#/operations/createTask/input') ?? '';
  const inputValidator = created[inputReference];
  assert.ok(inputValidator);
  assert.equal(inputValidator({ body: task }), true);
  assert.equal(inputValidator({ body: { ...task, labels: [] } }), false);
  assert.ok(inputValidator.errors?.some((error: { keyword?: string }) => error.keyword === 'minItems'));

  const generatedCode = readFileSync(path.join(output, 'operations/createTask.validators.generated.js'), 'utf8');
  const browserModule = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(generatedCode)}`);
  const browserValidators = browserModule.createValidatorSet().first as Record<string, GeneratedValidator>;
  assert.equal(browserValidators[inputReference]({ body: task }), true);
  assert.equal(browserValidators[inputReference]({ body: { ...task, when: 'not-a-date' } }), false);

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

test('custom synchronous validation bindings have identical JIT and standalone behavior and are not called during generation', async () => {
  const id = 'urn:golem:custom-validation';
  const schema = {
    $id: id,
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: {
      value: { type: 'integer', exprtValidation: ['isEven'] },
    },
  };
  let calls = 0;
  const isEven = (value: unknown): boolean | string => {
    calls++;
    return typeof value === 'number' && value % 2 === 0 ? true : 'must be even';
  };
  const compiled = compileStandaloneValidatorSet({ schemas: { [id]: schema }, references: [id], owner: 'standalone.test' });
  assert.equal(calls, 0);
  assert.doesNotMatch(compiled.code, /(?:from|require\s*\()\s*['"](?:ajv|ajv-formats|fast-deep-equal)/);
  const standaloneModule = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled.code)}`);
  const standaloneValidator = standaloneModule.createValidators({ isEven })[id] as GeneratedValidator;
  const jitEngine = createOpenApiAjvEngine({ validationBindings: { isEven } });
  jitEngine.addSchema(schema, id);
  const jitValidator = jitEngine.getSchema(id);
  assert.ok(jitValidator);
  if (!jitValidator) throw new Error('JIT validator was not registered');

  assert.equal(standaloneValidator({ value: 2 }), true);
  assert.equal(jitValidator({ value: 2 }), true);
  assert.equal(standaloneValidator({ value: 3 }), false);
  const standaloneErrors = standaloneValidator.errors;
  assert.equal(jitValidator({ value: 3 }), false);
  assert.deepEqual(jitValidator.errors, standaloneErrors);
  assert.equal(standaloneErrors?.[0]?.keyword, 'exprtValidation');
  assert.equal(standaloneErrors?.[0]?.message, 'must be even');
  assert.equal(calls, 4);
});
