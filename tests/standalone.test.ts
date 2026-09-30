import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createOpenApiAjvEngine } from '@exprtlabs/golem/ajv';
import { compileStandaloneValidators } from '@exprtlabs/golem/ajv-tooling';
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
  const generatedJavascript = path.join(output, 'validators.generated.js');
  compileGeneratedSdk(
    output,
    [path.join(output, 'validation-engine.ts'), ...(existsSync(generatedJavascript) ? [generatedJavascript] : [])],
    { strict: true, skipLibCheck: true, outDir },
  );
  return outDir;
}

function generatedReferenceSet(schemas: {
  schemaRegistry: Record<string, unknown>;
  schemaNames: readonly string[];
  operationNames: readonly string[];
  operationResponseSchemaEntries: readonly (readonly [string, string, string])[];
  schemaReference: (name: string) => string;
  operationInputReference: (name: string) => string;
  operationResponseReference: (name: string, status: string, contentType: string) => string;
}): Set<string> {
  const references = new Set<string>([schemas.schemaRegistry.$id as string]);
  const defs = schemas.schemaRegistry.$defs;
  if (defs && typeof defs === 'object') {
    for (const definition of Object.values(defs as Record<string, unknown>)) {
      if (definition && typeof definition === 'object' && typeof Reflect.get(definition, '$id') === 'string') {
        references.add(Reflect.get(definition, '$id') as string);
      }
    }
  }
  for (const name of schemas.schemaNames) references.add(schemas.schemaReference(name));
  for (const name of schemas.operationNames) references.add(schemas.operationInputReference(name));
  for (const [name, status, contentType] of schemas.operationResponseSchemaEntries) {
    references.add(schemas.operationResponseReference(name, status, contentType));
  }
  return references;
}

test('OpenAPI standalone profile emits self-contained validators while default validation stays runtime based', () => {
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
  assert.equal(runtimeNames.includes('validators.generated.js'), false);
  assert.equal(runtimeNames.includes('validators.generated.d.ts'), false);
  assert.equal(runtimeNames.includes('validators.generated.NOTICES.txt'), false);
  assert.equal(runtimeNames.includes('validation-engine.ts'), false);
  const runtimeModels = generatedModelSource(runtime.artifacts);
  assert.match(runtimeModels, /@exprtlabs\/golem\/ajv/);
  assert.doesNotMatch(runtimeModels, /validation-engine\.js/);
  const runtimeManifest = JSON.parse(runtime.artifacts.find(item => item.path.endsWith('/model-manifest.json'))?.content ?? '{}') as {
    profile?: { ajvStandalone?: boolean; allowAny?: boolean };
  };
  assert.equal(runtimeManifest.profile?.ajvStandalone, false);
  assert.equal(runtimeManifest.profile?.allowAny, false);

  const standaloneNames = artifactBasenames(standalone.artifacts);
  for (const name of ['validators.generated.js', 'validators.generated.d.ts', 'validators.generated.NOTICES.txt', 'validation-engine.ts']) {
    assert.equal(standaloneNames.includes(name), true, name);
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
  const notices = standalone.artifacts.find(item => item.path.endsWith('validators.generated.NOTICES.txt'))?.content ?? '';
  assert.match(notices, /ajv/);
  assert.match(notices, /ajv-formats/);
  assert.match(notices, /fast-deep-equal/);
});

test('standalone SDK compiles a no-content operation with no response validators', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'runic-openapi-no-content-'));
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

test('standalone SDK compiles with its generated JavaScript, exposes every model and operation reference, and rejects replacement engines', async t => {
  const output = path.join(mkdtempSync(path.join(tmpdir(), 'runic-openapi-standalone-')), 'sdk');
  t.after(() => rmSync(path.dirname(output), { recursive: true, force: true }));
  const result = await generateMaterializedSdk(standaloneDocument(), {
    output,
    name: 'Standalone',
    profile,
  });
  const compiled = compileStandaloneSdk(output);
  const generatedCode = readFileSync(path.join(output, 'validators.generated.js'), 'utf8');
  assert.doesNotMatch(generatedCode, /(?:from|require\s*\()\s*['"](?:ajv|ajv-formats|fast-deep-equal)/);
  assert.doesNotMatch(generatedCode, /new\s+Function|\beval\s*\(/);
  assert.match(readFileSync(path.join(output, 'validators.generated.NOTICES.txt'), 'utf8'), /ajv/);
  assert.ok(result.artifacts.some(item => item.path.endsWith('/validators.generated.d.ts')));

  const generated = await import(pathToFileURL(path.join(compiled, 'validators.generated.js')).href);
  const schemas = await import(pathToFileURL(path.join(compiled, 'schemas.js')).href) as {
    schemaRegistry: Record<string, unknown>;
    runtimeSchemaRegistry: object;
    schemaNames: readonly string[];
    operationNames: readonly string[];
    operationResponseSchemaEntries: readonly (readonly [string, string, string])[];
    schemaReference: (name: string) => string;
    operationInputReference: (name: string) => string;
    operationResponseReference: (name: string, status: string, contentType: string) => string;
    createRuntimeValidators: (engine: object) => unknown;
    createOperationRuntimeValidators: (engine: object) => ReadonlyMap<string, { input: (value: unknown) => boolean }>;
  };
  const validators = generated.createValidators() as Record<string, GeneratedValidator>;
  const expected = generatedReferenceSet(schemas);
  assert.deepEqual(new Set(Object.keys(validators)), expected);
  for (const reference of expected) assert.equal(typeof validators[reference], 'function', reference);

  const task = { id: 'task-1', when: '2025-01-02T03:04:05Z', child: { id: 'child-1' }, labels: ['one'] };
  const inputReference = schemas.operationInputReference('createTask');
  const inputValidator = validators[inputReference];
  assert.equal(inputValidator({ body: task }), true);
  assert.equal(inputValidator({ body: { ...task, labels: [] } }), false);
  assert.ok(inputValidator.errors?.some((error: { keyword?: string }) => error.keyword === 'minItems'));

  const browserModule = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(generatedCode)}`);
  const browserValidators = browserModule.createValidators() as Record<string, GeneratedValidator>;
  assert.equal(browserValidators[inputReference]({ body: task }), true);
  assert.equal(browserValidators[inputReference]({ body: { ...task, when: 'not-a-date' } }), false);

  const engineModule = await import(pathToFileURL(path.join(compiled, 'validation-engine.js')).href);
  const operationValidators = schemas.createOperationRuntimeValidators(engineModule.defaultValidationEngine);
  assert.equal(operationValidators.size, 2);
  assert.equal(operationValidators.get('createTask')?.input({ body: task }), true);
  assert.equal(operationValidators.get('getTask')?.input({ path: { id: 'task-1' } }), true);

  const unknown = `${schemas.schemaRegistry.$id}#/unknown`;
  assert.equal(engineModule.defaultValidationEngine.getSchema(unknown), undefined);
  assert.throws(
    () => engineModule.defaultValidationEngine.addSchema({ changed: true }, schemas.schemaRegistry.$id),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
  assert.throws(
    () => schemas.createRuntimeValidators({
      addSchema() { /* replacement engines cannot silently compile schemas */ },
      getSchema() { return undefined; },
    }),
    /Runtime validator could not compile schema/,
  );
});

test('custom synchronous validation bindings have identical JIT and standalone behavior and are not called during generation', async () => {
  const id = 'urn:runic:custom-validation';
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
  const compiled = compileStandaloneValidators({ schemas: { [id]: schema }, references: [id], owner: 'standalone.test' });
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
