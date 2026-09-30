import type { TestContext } from 'node:test';
import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  ALL_GENERATION_PROFILES,
  compileStrictUnusedSdk,
  defaultTestProfile,
  generateMaterializedSdk,
  generatedClientSource,
  isGeneratedClientClass,
  requireRecord,
  type OpenApiGenerationProfile,
} from './helpers.js';

test('applicable custom codecs override built-in request, parameter, response and header codecs', async t => {
  const document = {
    openapi: '3.1.0', info: info('Overrides'),
    paths: { '/value': { post: {
      operationId: 'sendValue',
      parameters: [
        { name: 'filter', in: 'query', content: { 'application/json': { schema: { type: 'object' } } } },
        { name: 'x-meta', in: 'header', content: { 'application/json': { schema: { type: 'object' } } } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { '200': {
        description: 'binary',
        headers: { 'x-result': { content: { 'application/json': { schema: { type: 'object' } } } } },
        content: { 'application/octet-stream': {} },
      } },
    } } },
  };
  const output = outputDir(t, 'overrides');
  await generateMaterializedSdk(document, { output, name: 'Overrides', profile: { mobx: false, validation: true } });
  compileStrictUnusedSdk(output);
  const module = requireRecord(await import(pathToFileURL(path.join(output, 'dist/client.js')).href), 'override client');
  const Client = module.OverridesClient;
  assert.ok(isGeneratedClientClass(Client));
  if (!isGeneratedClientClass(Client)) throw new TypeError('OverridesClient');
  const calls: string[] = [];
  const client = new Client({
    baseUrl: 'https://example.test',
    parameterSerializers: { 'application/json': (_value: unknown, context: { in: string }) => {
      calls.push(context.in);
      return context.in === 'query' ? 'search' : 'literal %2F header';
    } },
    bodyEncoders: { 'application/json': (value: unknown) => {
      calls.push('body');
      return JSON.stringify({ wrapped: value });
    } },
    responseDecoders: { 'application/octet-stream': async (response: Response) => {
      assert.equal(await response.text(), 'wire');
      calls.push('response');
      return new Blob(['custom']);
    } },
    responseHeaderDecoders: { 'application/json': (value: string) => {
      assert.equal(value, 'not-json');
      calls.push('response-header');
      return { accepted: true };
    } },
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.url, 'https://example.test/value?filter=search');
      assert.equal(request.headers.get('x-meta'), 'literal %2F header');
      assert.deepEqual(await request.json(), { wrapped: { message: 'hello' } });
      return new Response('wire', { headers: { 'content-type': 'application/octet-stream', 'x-result': 'not-json' } });
    },
  });
  const response = await client.sendValue().execute({ body: { message: 'hello' }, query: { filter: {} }, header: { 'x-meta': {} } });
  assert.ok(response.body instanceof Blob);
  if (!(response.body instanceof Blob)) throw new TypeError('decoded blob');
  assert.equal(await response.body.text(), 'custom');
  assert.deepEqual(response.headers, { 'x-result': { accepted: true } });
  assert.deepEqual(calls, ['query', 'header', 'body', 'response', 'response-header']);
});

test('generated clients bind the default fetch to globalThis and call an explicit fetch without a receiver', async t => {
  const output = outputDir(t, 'fetch-receiver');
  await generateMaterializedSdk({
    openapi: '3.2.0',
    info: info('Fetch receiver'),
    paths: {
      '/value': {
        get: {
          operationId: 'getValue',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, { output, name: 'FetchReceiver', profile: { mobx: false, validation: false } });
  compileStrictUnusedSdk(output);
  const module = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'fetch receiver client',
  );
  const Client = module.FetchReceiverClient;
  assert.ok(isGeneratedClientClass(Client));
  if (!isGeneratedClientClass(Client)) throw new TypeError('FetchReceiverClient');

  const originalFetch = globalThis.fetch;
  const defaultReceivers: unknown[] = [];
  const defaultFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    defaultReceivers.push(this);
    const request = new Request(input, init);
    assert.equal(request.url, 'https://example.test/value');
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  };
  const explicitReceivers: unknown[] = [];
  const explicitFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    explicitReceivers.push(this);
    const request = new Request(input, init);
    assert.equal(request.url, 'https://example.test/value');
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  };

  try {
    globalThis.fetch = defaultFetch as typeof fetch;
    const defaultClient = new Client({ baseUrl: 'https://example.test' });
    const defaultResponse = await defaultClient.getValue().execute({});
    assert.deepEqual(defaultResponse.body, { ok: true });
    assert.deepEqual(defaultReceivers, [globalThis]);

    const explicitClient = new Client({ baseUrl: 'https://example.test', fetchImpl: explicitFetch });
    const explicitResponse = await explicitClient.getValue().execute({});
    assert.deepEqual(explicitResponse.body, { ok: true });
    // A native browser fetch throws "Illegal invocation" for any non-global receiver.
    assert.deepEqual(explicitReceivers, [undefined]);
    assert.deepEqual(defaultReceivers, [globalThis]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function info(title: string): { title: string; version: string } {
  return { title, version: '1' };
}

function outputDir(t: TestContext, label: string): string {
  return path.join(createFixtureProject(t, `runic-openapi-${label}-`), 'sdk');
}

test('directional imports follow schema references while literal data and keyword-shaped property names stay distinct', async t => {
  for (const referenceProperty of [false, true]) {
    const output = outputDir(t, `literal-reference-${referenceProperty}`);
    const schema = {
      type: 'object',
      properties: referenceProperty
        ? { default: { $ref: '#/components/schemas/Value' } }
        : { value: { type: 'object', default: { $ref: '#/components/schemas/Value' } } },
    };
    const result = await generateMaterializedSdk({
      openapi: '3.1.0', info: info('Literal'),
      components: { schemas: { Value: { type: 'object', properties: { name: { type: 'string' } } } } },
      paths: { '/value': { post: {
        operationId: 'postValue',
        requestBody: { content: { 'application/json': { schema } } },
        responses: { '200': { description: 'value', content: { 'application/json': { schema } } } },
      } } },
    }, { output, name: 'Literal', profile: { mobx: false, validation: false } });
    const types = result.artifacts.find(artifact => artifact.path.endsWith('/types.ts'))?.content ?? '';
    assert.equal(types.includes("import type * as InputSchemas"), referenceProperty);
    assert.equal(types.includes("import type * as OutputSchemas"), referenceProperty);
    compileStrictUnusedSdk(output);
  }
});

function emittedFiles(artifacts: readonly { path: string }[], output: string): string[] {
  return artifacts.map(artifact => path.relative(output, artifact.path)
    .replace(/^models\/_group-[a-f0-9]+\.ts$/, 'models/_group-<hash>.ts')).sort();
}

// The emitted file list is asserted for every profile; only the default (all-on) profile is compiled, unless the caller compiles elsewhere.
async function assertFilesPerProfile(
  t: TestContext,
  document: unknown,
  name: string,
  expected: (profile: OpenApiGenerationProfile) => readonly string[],
  compileDefaultProfile = true,
): Promise<void> {
  for (const profile of ALL_GENERATION_PROFILES) {
    const output = outputDir(t, `${name}-${profile.mobx}-${profile.validation}`);
    const result = await generateMaterializedSdk(document, { output, name, profile });
    assert.deepEqual(emittedFiles(result.artifacts, output), [...expected(profile)].sort());
    if (compileDefaultProfile && profile.mobx === defaultTestProfile.mobx && profile.validation === defaultTestProfile.validation) {
      compileStrictUnusedSdk(output);
    }
  }
}

test('schema-only documents emit types, directional files, and models without a client', async (t) => {
  await assertFilesPerProfile(t, {
    openapi: '3.2.0',
    info: info('SchemaOnly'),
    components: {
      schemas: {
        Widget: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
  }, 'SchemaOnly', (profile) => [
    'index.ts',
    'types.ts',
    'model-manifest.json',
    'input-schemas.ts',
    'output-schemas.ts',
    'models/Widget.ts',
    'models/_group-<hash>.ts',
    'iobject-plugin-keys.ts',
    ...(profile.validation ? ['schemas.ts'] : []),
  ]);
});

test('empty component documents emit only always-on artifacts', async (t) => {
  await assertFilesPerProfile(t, {
    openapi: '3.2.0',
    info: info('Empty'),
    components: {},
  }, 'Empty', () => ['index.ts', 'types.ts', 'model-manifest.json']);
});

function pingDocument(): unknown {
  return {
    openapi: '3.2.0',
    info: info('Ping'),
    paths: {
      '/ping': {
        get: {
          operationId: 'ping',
          responses: { 204: { description: 'ok' } },
        },
      },
    },
  };
}

test('generated SDKs import the client runtime instead of copying it', async t => {
  const output = outputDir(t, 'shared-runtime');
  const result = await generateMaterializedSdk({
    openapi: '3.2.0', info: info('Shared'),
    paths: { '/items/{id}': { get: {
      operationId: 'getItem',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'item', content: { 'application/json': { schema: { type: 'object' } } } } },
    } } },
  }, { output, name: 'Shared', profile: { mobx: false, validation: true } });
  const files = new Map(result.artifacts.map(artifact => [path.relative(output, artifact.path), artifact.content]));
  assert.equal([...files.keys()].some(file => file.endsWith('client-runtime.ts')), false);
  assert.match(files.get('operations/getItem.ts') ?? '', /from '@exprtlabs\/golem\/client'/);
});

test('minimal GET without content omits codec options and unused helpers', async (t) => {
  await assertFilesPerProfile(t, pingDocument(), 'Ping', () => [
    'index.ts',
    'types.ts',
    'model-manifest.json',
    'client.ts',
    'operations/ping.ts',
    'schemas.ts',
  ], false);

  const output = outputDir(t, 'codec-omit');
  await generateMaterializedSdk(pingDocument(), {
    output,
    name: 'Ping',
    profile: { mobx: false, validation: false },
  });
  const assertFile = copyFixtureFile(output, 'openapi/emission-plan/ping-client-assert.ts', 'ping-client-assert.ts');
  compileStrictUnusedSdk(output, [assertFile]);

  // Positive pairing: an operation with a request body, response body, item-schema
  // stream, and content-typed parameter has all four fields ping-client-assert.ts
  // proves absent, so a rename of a field couldn't make both fixtures pass vacuously.
  const surfacesOutput = outputDir(t, 'codec-surfaces-pairing');
  const surfaces = await generateMaterializedSdk({
    openapi: '3.2.0',
    info: info('PingSurfaces'),
    paths: {
      '/echo': {
        post: {
          operationId: 'echo',
          parameters: [
            { name: 'filter', in: 'query', content: { 'application/json': { schema: { type: 'object' } } } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { type: 'object' } },
                'application/x-ndjson': {
                  itemSchema: { type: 'object', properties: { id: { type: 'integer' } } },
                },
              },
            },
          },
        },
      },
    },
  }, { output: surfacesOutput, name: 'PingSurfaces', profile: { mobx: false, validation: false } });
  assert.ok(surfaces.artifacts.some(artifact => artifact.path.endsWith('client.ts')));
  const surfacesAssertFile = copyFixtureFile(
    surfacesOutput, 'openapi/emission-plan/ping-surfaces-client-assert.ts', 'ping-surfaces-client-assert.ts',
  );
  compileStrictUnusedSdk(surfacesOutput, [surfacesAssertFile]);
});

test('stream and mutual-TLS surfaces are emitted only when they are used', async (t) => {
  const itemSchema = { type: 'object', properties: { id: { type: 'integer' } } };
  const withSurfaces = await generateMaterializedSdk({
    openapi: '3.2.0',
    info: info('StreamSecurity'),
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        mtls: { type: 'mutualTLS' },
      },
    },
    paths: {
      '/events': {
        get: {
          operationId: 'events',
          security: [{ bearer: [] }],
          responses: { 200: { description: 'ok', content: { 'application/x-ndjson': { itemSchema } } } },
        },
      },
      '/rows': {
        get: {
          operationId: 'rows',
          security: [{ mtls: [] }],
          responses: { 200: { description: 'ok', content: { 'application/json-seq': { itemSchema } } } },
        },
      },
      '/live': {
        get: {
          operationId: 'live',
          responses: { 200: { description: 'ok', content: { 'text/event-stream': { itemSchema } } } },
        },
      },
    },
  }, { output: outputDir(t, 'stream-security-surfaces'), name: 'StreamSecurity', profile: { mobx: false, validation: false } });
  const client = generatedClientSource(withSurfaces.artifacts);
  assert.match(client, /StreamSecurityStreamDecoder\b/, 'the custom stream decoder surface is emitted for a stream response with an item schema');
  assert.match(client, /applySecurity/, 'the security call is emitted when a security scheme is used');
  assert.match(client, /StreamSecurityMutualTlsTransport\b/, 'the mutual TLS transport type is emitted when a mutualTLS scheme is used');
  assert.doesNotMatch(client, /readNdjson|readJsonSeq|readServerSentEvents/, 'stream readers live in the shared runtime');

  const plain = await generateMaterializedSdk({
    openapi: '3.2.0',
    info: info('NoStreamSecurity'),
    paths: {
      '/ping': {
        get: {
          operationId: 'ping',
          responses: { 204: { description: 'ok' } },
        },
      },
    },
  }, { output: outputDir(t, 'stream-security-surfaces-absent'), name: 'NoStreamSecurity', profile: { mobx: false, validation: false } });
  const plainClient = generatedClientSource(plain.artifacts);
  assert.doesNotMatch(plainClient, /StreamDecoder|MutualTlsTransport|applySecurity/);
});

test('the SDK entry re-exports each model module directly', async t => {
  const output = outputDir(t, 'direct-models');
  const result = await generateMaterializedSdk({
    openapi: '3.2.0', info: info('Direct'), paths: {},
    components: { schemas: {
      Money: { type: 'object', properties: { amount: { type: 'string' } }, required: ['amount'] },
      Payment: { type: 'object', properties: { money: { $ref: '#/components/schemas/Money' } }, required: ['money'] },
    } },
  }, { output, name: 'Direct', profile: { mobx: false, validation: false } });
  const files = new Map(result.artifacts.map(artifact => [path.relative(output, artifact.path), artifact.content]));
  assert.equal(files.has('models.ts'), false);
  const index = files.get('index.ts') ?? '';
  assert.match(index, /from '\.\/models\/Money\.js'/);
  assert.match(index, /from '\.\/models\/Payment\.js'/);
  assert.match(index, /export \* from '\.\/iobject-plugin-keys\.js'/);
});

test('an ajvStandalone validation SDK with operations compiles under strict unused checks', async t => {
  const output = outputDir(t, 'standalone-strict');
  await generateMaterializedSdk({
    openapi: '3.1.0', info: info('Standalone'),
    components: { schemas: { Item: {
      type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } },
    } } },
    paths: { '/items': { post: {
      operationId: 'createItem',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
    } } },
  }, { output, name: 'Standalone', profile: { mobx: false, validation: true, ajvStandalone: true } });
  compileStrictUnusedSdk(output);
});
