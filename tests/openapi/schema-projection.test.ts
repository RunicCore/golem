import type { TestContext } from 'node:test';
import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createOpenApiAjvEngine } from '@exprtlabs/codegen/ajv';
import { generate, findRemoteRefs, loadValidatedDocument } from '#openapi/generator';
import { collectCanonicalResources, projectSchema } from '#openapi/schema-projection';
import { buildSchemaData } from '#openapi/schemas';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  materializeGeneratedSdk,
  requireRecord,
} from './helpers.js';

test('equivalent directional resources share a scope while request and response rules remain distinct', () => {
  const document = (readOnly: boolean, ownId: boolean) => ({
    openapi: '3.1.0', info: { title: 'ResourceReuse', version: '1' },
    components: { schemas: { Item: {
      ...(ownId ? { $id: 'https://example.test/item' } : {}),
      type: 'object', required: ['name', 'id'], additionalProperties: false,
      properties: { name: { type: 'string' }, id: { type: 'string', ...(readOnly ? { readOnly: true } : {}) } },
    } } },
    paths: { '/items': { post: { operationId: 'save',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
      responses: { '200': { description: 'Saved', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
    } } },
  });
  for (const [readOnly, ownId] of [[false, false], [true, false], [false, true]] as const) {
    const data = buildSchemaData(document(readOnly, ownId));
    const registry = requireRecord(data.normalizedRegistry, 'registry');
    assert.equal(Object.keys(requireRecord(registry.$defs, 'directional resources')).length, readOnly || ownId ? 2 : 1);
    const engine = createOpenApiAjvEngine();
    engine.addSchema(registry, String(registry.$id));
    const input = engine.getSchema(`${registry.$id}#/operations/save/input`);
    const response = engine.getSchema(`${registry.$id}#/operations/save/responses/200/application~1json`);
    assert.ok(input); assert.ok(response);
    assert.equal(input({ body: { name: 'Example', id: '1' } }), !readOnly);
    assert.equal(input({ body: { name: 'Example' } }), readOnly);
    assert.equal(response({ name: 'Example', id: '1' }), true);
    assert.equal(response({ name: 'Example' }), false);
  }
});

function directionalComponents(openapi: string): Record<string, unknown> {
  return {
    openapi,
    info: { title: 'Projection', version: '1' },
    paths: {
      '/widgets': {
        post: {
          operationId: 'putWidget',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Widget: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'secret', 'serverValue'],
          properties: {
            id: { type: 'string' },
            secret: { type: 'string', writeOnly: true },
            serverValue: { type: 'string', readOnly: true },
          },
        },
        RequiredOnly: {
          required: ['ghost'],
          additionalProperties: true,
        },
      },
    },
  };
}

async function generateProjection(t: TestContext, openapi: string) {
  const output = path.join(createFixtureProject(t, 'runic-openapi-projection-'), 'sdk');
  const result = await generateMaterializedSdk(directionalComponents(openapi), {
    output,
    name: 'Projection',
    profile: { mobx: false, validation: true },
  });
  compileGeneratedSdk(output);
  const validation = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/validation.js')).href),
    'validation',
  );
  const schemas = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/schemas.js')).href),
    'schemas',
  );
  const manifest = result.artifacts.find((artifact) => artifact.path.endsWith('/model-manifest.json'))?.content ?? '';
  return { validation, schemas, manifest };
}

type OperationValidators = Map<string, {
  input: (value: unknown) => boolean | Promise<boolean>;
  responses: Map<string, (value: unknown) => boolean | Promise<boolean>>;
}>;

function operationValidators(validation: Record<string, unknown>): OperationValidators {
  const create = validation.createOperationRuntimeValidators as (
    engine: ReturnType<typeof createOpenApiAjvEngine>,
  ) => OperationValidators;
  return create(createOpenApiAjvEngine());
}

function modelValidators(validation: Record<string, unknown>): Map<string, (value: unknown) => boolean | Promise<boolean>> {
  const create = validation.createRuntimeValidators as (
    engine: ReturnType<typeof createOpenApiAjvEngine>,
  ) => Map<string, (value: unknown) => boolean | Promise<boolean>>;
  return create(createOpenApiAjvEngine());
}

test('repeated readOnly aliases drop every matching property and required entry', () => {
  const document = {
    components: {
      schemas: {
        ReadOnlyLabel: { type: 'string', readOnly: true },
        Thing: {
          type: 'object',
          required: ['first', 'second'],
          properties: {
            first: { $ref: '#/components/schemas/ReadOnlyLabel' },
            second: { $ref: '#/components/schemas/ReadOnlyLabel' },
          },
        },
        AllOfSibling: {
          allOf: [
            { properties: { secret: { type: 'string', writeOnly: true } } },
            { required: ['id', 'secret'], properties: { id: { type: 'string' } } },
          ],
        },
      },
    },
  };
  const schemas = requireRecord(requireRecord(document.components, 'components').schemas, 'schemas');
  const projected = projectSchema(requireRecord(schemas.Thing, 'Thing'), { document, direction: 'input' });
  assert.deepEqual(projected, { type: 'object' });
  const sibling = projectSchema(requireRecord(schemas.AllOfSibling, 'AllOfSibling'), {
    document,
    direction: 'output',
  });
  assert.deepEqual(sibling, {
    allOf: [
      {},
      { required: ['id'], properties: { id: { type: 'string' } } },
    ],
  });
});

test('public generation validates repeated aliases, sibling allOf required, and required-only control', async (t) => {
  const output = path.join(createFixtureProject(t, 'runic-openapi-alias-'), 'sdk');
  await generateMaterializedSdk({
    openapi: '3.1.0',
    info: { title: 'Aliases', version: '1' },
    paths: {
      '/user': {
        post: {
          operationId: 'createUser',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
            },
          },
        },
      },
      '/control': {
        post: {
          operationId: 'control',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RequiredOnly' } } },
          },
          responses: { 204: { description: 'ok' } },
        },
      },
    },
    components: {
      schemas: {
        ReadOnlyText: { type: 'string', readOnly: true },
        WriteOnlyText: { type: 'string', writeOnly: true },
        UserBase: {
          type: 'object',
          required: ['first', 'second', 'secretOne', 'secretTwo', 'name'],
          additionalProperties: false,
          properties: {
            first: { $ref: '#/components/schemas/ReadOnlyText' },
            second: { $ref: '#/components/schemas/ReadOnlyText' },
            secretOne: { $ref: '#/components/schemas/WriteOnlyText' },
            secretTwo: { $ref: '#/components/schemas/WriteOnlyText' },
            name: { type: 'string', minLength: 1 },
          },
        },
        User: {
          allOf: [
            { $ref: '#/components/schemas/UserBase' },
            { required: ['first', 'second', 'secretOne', 'secretTwo'] },
          ],
        },
        RequiredOnly: {
          type: 'object',
          required: ['token'],
          additionalProperties: { type: 'string' },
        },
      },
    },
  }, { output, name: 'Aliases', profile: { mobx: false, validation: true } });
  copyFixtureFile(output, "openapi/schema-projection/alias-assert.ts", "alias-assert.ts");
  compileGeneratedSdk(output, [path.join(output, 'alias-assert.ts')], { strict: true });
  const validation = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/validation.js')).href),
    'validation',
  );
  const operations = operationValidators(validation);
  const models = modelValidators(validation);
  const input = operations.get('createUser')?.input;
  const response = operations.get('createUser')?.responses.get('200:application/json');
  const control = operations.get('control')?.input;
  const userModel = models.get('UserBase');
  assert.ok(input && response && control && userModel);

  const request = { name: 'Ada', secretOne: 'one', secretTwo: 'two' };
  const reply = { name: 'Ada', first: 'id-1', second: 'id-2' };
  assert.equal(await input({ body: request }), true);
  assert.equal(await input({ body: { name: 'Ada', first: 'id-1', second: 'id-2' } }), false);
  assert.equal(await response(reply), true);
  assert.equal(await response({ name: 'Ada', secretOne: 'one', secretTwo: 'two' }), false);
  assert.equal(await control({ body: {} }), false);
  assert.equal(await control({ body: { token: 'present' } }), true);
  assert.equal(await userModel({ name: 'Ada' }), false);
  assert.equal(await userModel({ ...request, ...reply }), true);
});

function directionalUserEnvelope(userId: string, envelopeId: string, userRef: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'Absolute', version: '1' },
    paths: {
      '/envelope': {
        post: {
          operationId: 'putEnvelope',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        User: {
          $id: userId,
          type: 'object',
          additionalProperties: false,
          required: ['id', 'secret', 'serverValue'],
          properties: {
            id: { type: 'string' },
            secret: { type: 'string', writeOnly: true },
            serverValue: { type: 'string', readOnly: true },
          },
        },
        Envelope: {
          $id: envelopeId,
          type: 'object',
          additionalProperties: false,
          required: ['user', 'relative'],
          properties: {
            user: { $ref: userRef },
            relative: { $ref: 'user' },
          },
        },
      },
    },
  };
}

async function assertDirectionalEnvelope(
  output: string,
  artifacts: readonly { path: string; content: string }[],
  userId: string,
): Promise<void> {
  compileGeneratedSdk(output);
  const escaped = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const schemasText = artifacts.find((artifact) => artifact.path.endsWith('/schemas.ts'))?.content ?? '';
  assert.match(schemasText, new RegExp(`${escaped}:input`));
  assert.match(schemasText, new RegExp(`${escaped}:output`));
  const inputPack = schemasText.split('runic-input')[1]?.split('runic-output')[0] ?? '';
  assert.doesNotMatch(inputPack, new RegExp(`"user": \\{\\s*"\\$ref": "${escaped}"`));
  assert.match(inputPack, new RegExp(`${escaped}:input`));

  const validation = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/validation.js')).href),
    'validation',
  );
  const operations = operationValidators(validation);
  const models = modelValidators(validation);
  const input = operations.get('putEnvelope')?.input;
  const response = operations.get('putEnvelope')?.responses.get('200:application/json');
  const userModel = models.get('User');
  assert.ok(input && response && userModel);

  const requestUser = { id: 'u1', secret: 's' };
  const replyUser = { id: 'u1', serverValue: 'ok' };
  assert.equal(await input({ body: { user: requestUser, relative: requestUser } }), true);
  assert.equal(await input({ body: { user: replyUser, relative: replyUser } }), false);
  assert.equal(await response({ user: replyUser, relative: replyUser }), true);
  assert.equal(await response({ user: requestUser, relative: requestUser }), false);
  assert.equal(await userModel({ id: 'u1', secret: 's', serverValue: 'ok' }), true);
  assert.equal(await userModel({ id: 'u1', secret: 's' }), false);
}

test('absolute and relative $id refs remap onto directional resources for Ajv', async (t) => {
  const output = path.join(createFixtureProject(t, 'runic-openapi-absid-'), 'sdk');
  const document = directionalUserEnvelope(
    'https://schemas.example.test/user',
    'https://schemas.example.test/envelope',
    'https://schemas.example.test/user',
  );
  assert.equal(findRemoteRefs(document).length, 0);
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    fetched = true;
    return originalFetch(...args);
  };
  try {
    const result = await generateMaterializedSdk(document, {
      output,
      name: 'Absolute',
      profile: { mobx: false, validation: true },
    });
    await assertDirectionalEnvelope(output, result.artifacts, 'https://schemas.example.test/user');
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('undeclared HTTPS schema refs stay blocked without network', async (t) => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'RemoteBlocked', version: '1' },
    paths: {
      '/x': {
        get: {
          operationId: 'getX',
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Local' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Local: {
          $id: 'https://schemas.example.test/local',
          type: 'object',
        },
        Remote: { $ref: 'https://schemas.example.test/undeclared' },
      },
    },
  };
  const remotes = findRemoteRefs(document);
  assert.equal(remotes.length, 1);
  assert.equal(remotes[0]?.ref, 'https://schemas.example.test/undeclared');
  const directory = createFixtureProject(t, 'runic-openapi-blocked-https-');
  writeFileSync(path.join(directory, 'openapi.json'), `${JSON.stringify(document)}\n`);
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    fetched = true;
    return originalFetch(...args);
  };
  try {
    await assert.rejects(
      () => loadValidatedDocument(path.join(directory, 'openapi.json'), {}),
      /remote reference blocked at #\/components\/schemas\/Remote\/\$ref/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('literal example and default $ref values are not treated as schema references', async (t) => {
  const output = path.join(createFixtureProject(t, 'runic-openapi-literal-ref-'), 'sdk');
  const document = {
    openapi: '3.1.0',
    info: { title: 'LiteralRef', version: '1' },
    paths: {
      '/x': {
        post: {
          operationId: 'putX',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Payload' },
              },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Payload: {
          type: 'object',
          additionalProperties: false,
          properties: {
            planted: {
              default: { $ref: 'https://evil.example/default-ref', planted: true },
              examples: [{ $ref: 'https://evil.example/not-a-schema', marker: 'example' }],
            },
          },
        },
      },
    },
  };
  assert.equal(findRemoteRefs(document).length, 0);
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    fetched = true;
    return originalFetch(...args);
  };
  try {
    const result = await generateMaterializedSdk(document, {
      output,
      name: 'LiteralRef',
      profile: { mobx: false, validation: true },
    });
    compileGeneratedSdk(output);
    const schemasText = result.artifacts.find((artifact) => artifact.path.endsWith('/schemas.ts'))?.content ?? '';
    assert.match(schemasText, /https:\/\/evil\.example\/not-a-schema/);
    assert.match(schemasText, /https:\/\/evil\.example\/default-ref/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('duplicate conflicting $id values are rejected', () => {
  assert.throws(
    () => collectCanonicalResources({
      components: {
        schemas: {
          One: { $id: 'https://schemas.example.test/shared', type: 'string' },
          Two: { $id: 'https://schemas.example.test/shared', type: 'number' },
        },
      },
    }),
    /duplicate JSON Schema \$id/,
  );
});

test('directional projection is consistent on OAS 3.1 and 3.2 and keeps neutral model identity', async (t) => {
  for (const openapi of ['3.1.0', '3.2.0']) {
    const generated = await generateProjection(t, openapi);
    const manifest = requireRecord(JSON.parse(generated.manifest), 'model manifest');
    assert.ok(Array.isArray(manifest.models));
    for (const entry of manifest.models) {
      const model = requireRecord(entry, 'manifest model');
      const type = requireRecord(model.type, 'model type');
      const implementation = requireRecord(model.generated, 'generated model');
      assert.equal(implementation.module, `./models/${String(type.export)}.ts`);
      assert.equal(implementation.export, `${String(type.export)}Model`);
    }

    const operations = operationValidators(generated.validation);
    const models = modelValidators(generated.validation);
    const widgetInput = operations.get('putWidget')?.input;
    const widgetResponse = operations.get('putWidget')?.responses.get('200:application/json');
    const widgetModel = models.get('Widget');
    assert.ok(widgetInput && widgetResponse && widgetModel);

    assert.equal(await widgetInput({ body: { id: 'w1', secret: 's' } }), true);
    assert.equal(await widgetInput({ body: { id: 'w1', serverValue: 'no' } }), false);
    assert.equal(await widgetResponse({ id: 'w1', serverValue: 'ok' }), true);
    assert.equal(await widgetResponse({ id: 'w1', secret: 'no' }), false);

    assert.equal(await widgetModel({ id: 'w1', secret: 's', serverValue: 'ok' }), true);

    const requiredOnly = models.get('RequiredOnly');
    assert.ok(requiredOnly);
    assert.equal(await requiredOnly({ ghost: 1 }), true);
    assert.equal(await requiredOnly({}), false);

    const registry = requireRecord(generated.schemas.runtimeSchemaRegistry, 'runtimeSchemaRegistry');
    const defs = requireRecord(registry.$defs, '$defs');
    const inputResource = requireRecord(defs['runic-input'], 'runic-input');
    const outputResource = requireRecord(defs['runic-output'], 'runic-output');
    assert.match(String(inputResource.$id), /:input$/);
    assert.match(String(outputResource.$id), /:output$/);
    assert.notEqual(inputResource.$id, outputResource.$id);
    assert.notEqual(inputResource.$id, registry.$id);
  }
});

test('an external ./nested.json $ref projects directionally without cloning components under the same $id', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-proj-ext-');
  writeFileSync(path.join(directory, 'nested.json'), JSON.stringify({
    type: 'object',
    properties: {
      hidden: { type: 'string', readOnly: true },
      visible: { type: 'string' },
    },
  }));
  writeFileSync(path.join(directory, 'openapi.json'), JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'External', version: '1' },
    paths: {
      '/n': {
        post: {
          operationId: 'putNested',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: './nested.json' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: './nested.json' } } },
            },
          },
        },
      },
    },
  }));
  const output = path.join(directory, 'sdk');
  const result = await generate({
    input: path.join(directory, 'openapi.json'),
    output,
    name: 'External',
    profile: { mobx: false, validation: true },
  });
  materializeGeneratedSdk(result.artifacts, output);
  compileGeneratedSdk(output);
  const inputSchemas = result.artifacts.find((artifact) => artifact.path.endsWith('/input-schemas.ts'))?.content ?? '';
  assert.doesNotMatch(inputSchemas, /hidden/);
  const schemas = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/schemas.js')).href),
    'schemas',
  );
  const registry = requireRecord(schemas.runtimeSchemaRegistry, 'registry');
  const defs = requireRecord(registry.$defs, '$defs');
  const inputResource = requireRecord(defs['runic-input'] as object, 'input');
  const outputResource = requireRecord(defs['runic-output'] as object, 'output');
  assert.notEqual(inputResource.$id, registry.$id);
  assert.notEqual(outputResource.$id, registry.$id);
});
