import type { TestContext } from 'node:test';
import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createOpenApiAjvEngine } from '@exprtlabs/golem/ajv';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { generate, findRemoteRefs, loadValidatedDocument } from '#openapi/generator';
import { collectCanonicalResources, projectSchema } from '#openapi/schema-projection';
import { buildSchemaData } from '#openapi/schemas';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
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

function runtimeRegistryFromArtifact(artifacts: readonly { path: string; content: string }[]): Record<string, unknown> {
  const text = artifacts.find((artifact) => artifact.path.endsWith('/schemas.ts'))?.content ?? '';
  const literal = (name: string) => new RegExp(`^export const ${name} = (\\{[\\s\\S]*?\\}) as const;$`, 'm').exec(text)?.[1];
  const json = literal('runtimeSchemaRegistry') ?? literal('schemaRegistry');
  assert.ok(json, 'schemas.ts carries the registry literal');
  return requireRecord(JSON.parse(json), 'runtimeSchemaRegistry');
}

async function generateProjection(t: TestContext, openapi: string) {
  const output = path.join(createFixtureProject(t, 'golem-openapi-projection-'), 'sdk');
  const result = await generateMaterializedSdk(directionalComponents(openapi), {
    output,
    name: 'Projection',
    profile: standaloneProfile,
  });
  const manifest = result.artifacts.find((artifact) => artifact.path.endsWith('/model-manifest.json'))?.content ?? '';
  return { output, manifest, registry: runtimeRegistryFromArtifact(result.artifacts), artifacts: result.artifacts };
}

/** Only a standalone SDK emits the registries; its operations validate with the standalone validators. */
const standaloneProfile = { mobx: false, validation: true, ajvStandalone: true } as const;

interface OperationProbe {
  /** True when the client let the input through to the transport. */
  acceptsInput(operation: string, input: unknown): Promise<boolean>;
  /** True when the response check passed for a valid input and the given reply body. */
  acceptsResponse(operation: string, input: unknown, reply: unknown): Promise<boolean>;
}

async function operationProbe(output: string, clientName: string): Promise<OperationProbe> {
  const module = requireRecord(await import(pathToFileURL(path.join(output, 'dist/client.js')).href), 'generated client module');
  const Client = module[`${clientName}Client`];
  assert.ok(isGeneratedClientClass(Client), `${clientName}Client`);
  if (!isGeneratedClientClass(Client)) throw new TypeError(`${clientName}Client`);
  let fetches = 0;
  let reply: unknown = {};
  const client = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    async acceptsInput(operation, input) {
      const before = fetches;
      await client[operation]().execute(input).catch(() => undefined);
      return fetches > before;
    },
    async acceptsResponse(operation, input, body) {
      reply = body;
      try {
        await client[operation]().execute(input);
        return true;
      } catch (error) {
        if (error instanceof LibError && error.kind === LibErrorKind.Validation) return false;
        throw error;
      }
    },
  };
}

/** Validates a value against one neutral component schema of the emitted registry. */
function componentValidator(registry: Record<string, unknown>, name: string): (value: unknown) => boolean | Promise<boolean> {
  const engine = createOpenApiAjvEngine();
  const id = String(registry.$id);
  if (!engine.getSchema(id)) engine.addSchema(registry, id);
  for (const resource of Object.values(requireRecord(registry.$defs ?? {}, 'registry resources'))) {
    const resourceId = isRecordWithId(resource) ? resource.$id : undefined;
    if (resourceId !== undefined && !engine.getSchema(resourceId)) engine.addSchema(resource as object, resourceId);
  }
  const token = encodeURIComponent(name.replace(/~/g, '~0').replace(/\//g, '~1'));
  const validator = engine.getSchema(`${id}#/components/schemas/${token}`);
  assert.ok(validator, `component schema ${name} compiles`);
  return validator;
}

function isRecordWithId(value: unknown): value is { $id: string } {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, '$id') === 'string';
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
  const output = path.join(createFixtureProject(t, 'golem-openapi-alias-'), 'sdk');
  const generated = await generateMaterializedSdk({
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
  }, { output, name: 'Aliases', profile: standaloneProfile });
  copyFixtureFile(output, "openapi/schema-projection/alias-assert.ts", "alias-assert.ts");
  compileGeneratedSdk(output, [path.join(output, 'alias-assert.ts')], { strict: true });
  const probe = await operationProbe(output, 'Aliases');
  const userModel = componentValidator(runtimeRegistryFromArtifact(generated.artifacts), 'UserBase');

  const request = { name: 'Ada', secretOne: 'one', secretTwo: 'two' };
  const reply = { name: 'Ada', first: 'id-1', second: 'id-2' };
  assert.equal(await probe.acceptsInput('createUser', { body: request }), true);
  assert.equal(await probe.acceptsInput('createUser', { body: { name: 'Ada', first: 'id-1', second: 'id-2' } }), false);
  assert.equal(await probe.acceptsResponse('createUser', { body: request }, reply), true);
  assert.equal(await probe.acceptsResponse('createUser', { body: request }, { name: 'Ada', secretOne: 'one', secretTwo: 'two' }), false);
  assert.equal(await probe.acceptsInput('control', { body: {} }), false);
  assert.equal(await probe.acceptsInput('control', { body: { token: 'present' } }), true);
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
  const inputPack = schemasText.split('golem-input')[1]?.split('golem-output')[0] ?? '';
  assert.doesNotMatch(inputPack, new RegExp(`"user": \\{\\s*"\\$ref": "${escaped}"`));
  assert.match(inputPack, new RegExp(`${escaped}:input`));

  const probe = await operationProbe(output, 'Absolute');
  const userModel = componentValidator(runtimeRegistryFromArtifact(artifacts), 'User');

  const requestUser = { id: 'u1', secret: 's' };
  const replyUser = { id: 'u1', serverValue: 'ok' };
  const requestBody = { body: { user: requestUser, relative: requestUser } };
  assert.equal(await probe.acceptsInput('putEnvelope', requestBody), true);
  assert.equal(await probe.acceptsInput('putEnvelope', { body: { user: replyUser, relative: replyUser } }), false);
  assert.equal(await probe.acceptsResponse('putEnvelope', requestBody, { user: replyUser, relative: replyUser }), true);
  assert.equal(await probe.acceptsResponse('putEnvelope', requestBody, { user: requestUser, relative: requestUser }), false);
  assert.equal(await userModel({ id: 'u1', secret: 's', serverValue: 'ok' }), true);
  assert.equal(await userModel({ id: 'u1', secret: 's' }), false);
}

test('absolute and relative $id refs remap onto directional resources for Ajv', async (t) => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-absid-'), 'sdk');
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
      profile: standaloneProfile,
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
  const directory = createFixtureProject(t, 'golem-openapi-blocked-https-');
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
  const output = path.join(createFixtureProject(t, 'golem-openapi-literal-ref-'), 'sdk');
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
      profile: standaloneProfile,
    });
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
  const emitted: Record<string, Record<string, string>> = {};
  for (const openapi of ['3.1.0', '3.2.0']) {
    const generated = await generateProjection(t, openapi);
    emitted[openapi] = Object.fromEntries(generated.artifacts.map((artifact) => [
      path.relative(generated.output, artifact.path),
      artifact.content
        .replace(/[0-9a-f]{64}/g, '<digest>')
        .replace(/openapi:[0-9a-f]{16}/g, 'openapi:<id>')
        .replace(/oas\/3\.[12]\/dialect/g, 'oas/<version>/dialect')
        .replace(/"dialect": "3\.[12]\.0"/g, '"dialect": "<version>"'),
    ]));
    const manifest = requireRecord(JSON.parse(generated.manifest), 'model manifest');
    assert.ok(Array.isArray(manifest.models));
    for (const entry of manifest.models) {
      const model = requireRecord(entry, 'manifest model');
      const type = requireRecord(model.type, 'model type');
      const implementation = requireRecord(model.generated, 'generated model');
      assert.equal(implementation.module, `./models/${String(type.export)}.ts`);
      assert.equal(implementation.export, `${String(type.export)}Model`);
    }

    const defs = requireRecord(generated.registry.$defs, '$defs');
    const inputResource = requireRecord(defs['golem-input'], 'golem-input');
    const outputResource = requireRecord(defs['golem-output'], 'golem-output');
    assert.match(String(inputResource.$id), /:input$/);
    assert.match(String(outputResource.$id), /:output$/);
    assert.notEqual(inputResource.$id, outputResource.$id);
    assert.notEqual(inputResource.$id, generated.registry.$id);

    if (openapi !== '3.1.0') {
      assert.deepEqual(emitted[openapi], emitted['3.1.0'], '3.2 emits the same validators as 3.1 apart from digest and dialect markers');
      continue;
    }
    compileGeneratedSdk(generated.output);
    const probe = await operationProbe(generated.output, 'Projection');
    const widgetModel = componentValidator(generated.registry, 'Widget');
    const widgetRequest = { body: { id: 'w1', secret: 's' } };

    assert.equal(await probe.acceptsInput('putWidget', widgetRequest), true);
    assert.equal(await probe.acceptsInput('putWidget', { body: { id: 'w1', serverValue: 'no' } }), false);
    assert.equal(await probe.acceptsResponse('putWidget', widgetRequest, { id: 'w1', serverValue: 'ok' }), true);
    assert.equal(await probe.acceptsResponse('putWidget', widgetRequest, { id: 'w1', secret: 'no' }), false);

    assert.equal(await widgetModel({ id: 'w1', secret: 's', serverValue: 'ok' }), true);

    const requiredOnly = componentValidator(generated.registry, 'RequiredOnly');
    assert.equal(await requiredOnly({ ghost: 1 }), true);
    assert.equal(await requiredOnly({}), false);
  }
});

test('an external ./nested.json $ref projects directionally without cloning components under the same $id', async (t) => {
  const directory = createFixtureProject(t, 'golem-openapi-proj-ext-');
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
    profile: standaloneProfile,
  });
  const inputSchemas = result.artifacts.find((artifact) => artifact.path.endsWith('/input-schemas.ts'))?.content ?? '';
  assert.doesNotMatch(inputSchemas, /hidden/);
  const registry = runtimeRegistryFromArtifact(result.artifacts);
  const defs = requireRecord(registry.$defs, '$defs');
  const inputResource = requireRecord(defs['golem-input'] as object, 'input');
  const outputResource = requireRecord(defs['golem-output'] as object, 'output');
  assert.notEqual(inputResource.$id, registry.$id);
  assert.notEqual(outputResource.$id, registry.$id);
});
