import type { TestContext } from 'node:test';
import { copyFixtureFile, createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { isUndeclaredResponseError } from '@exprtlabs/golem/client';
import {
  ALL_GENERATION_PROFILES,
  compileStrictUnusedSdk,
  defaultTestProfile,
  generateMaterializedSdk,
  isGeneratedClientClass,
  isGeneratedModelClass,
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
  return path.join(createFixtureProject(t, `golem-openapi-${label}-`), 'sdk');
}

/** A type-assert file compiled with the SDK: `@ts-expect-error` lines fail the compile when the error disappears. */
function writeAssertFile(output: string, name: string, source: string): string {
  const file = path.join(output, name);
  writeFileSync(file, source);
  return file;
}

async function importClient(output: string, label: string): Promise<Record<string, unknown>> {
  return requireRecord(await import(pathToFileURL(path.join(output, 'dist/client.js')).href), label);
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
    await generateMaterializedSdk({
      openapi: '3.1.0', info: info('Literal'),
      components: { schemas: { Value: { type: 'object', properties: { name: { type: 'string' } } } } },
      paths: { '/value': { post: {
        operationId: 'postValue',
        requestBody: { content: { 'application/json': { schema } } },
        responses: { '200': { description: 'value', content: { 'application/json': { schema } } } },
      } } },
    }, { output, name: 'Literal', profile: { mobx: false, validation: false } });
    // An import the types do not use fails the strict unused compile; a missing one fails on the name the types use.
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
    ...(profile.validation ? ['validators.generated.ts'] : []),
  ]);
});

test('operation names are typed inside client.ts and links.ts', async t => {
  const output = outputDir(t, 'operation-name-types');
  await generateMaterializedSdk({
    openapi: '3.2.0',
    info: info('Names'),
    paths: {
      '/a': { get: {
        operationId: 'getA',
        responses: { '200': {
          description: 'ok',
          links: { toB: { operationId: 'getB' } },
          content: { 'application/json': { schema: { type: 'object' } } },
        } },
      } },
      '/b': { get: { operationId: 'getB', responses: { '204': { description: 'ok' } } } },
    },
  }, { output, name: 'Names', profile: { mobx: false, validation: true } });
  const assertFile = writeAssertFile(output, 'names-assert.ts', `import type { OperationRuntimeValidators } from '@exprtlabs/golem/validation';
import type { NamesClientOptions } from './client.js';
import type { ResponseLink } from './links.js';
const options: NamesClientOptions = { baseUrl: 'https://example.test', operationValidators: new Map<'getA' | 'getB', OperationRuntimeValidators>() };
// @ts-expect-error validators are keyed by the operation names of the document
void ({ ...options, operationValidators: new Map<'getC', OperationRuntimeValidators>() } satisfies NamesClientOptions);
const link: ResponseLink = { operationId: 'getB', parameters: {} };
// @ts-expect-error a link targets an operation the document defines
void ({ ...link, operationId: 'getC' } satisfies ResponseLink);
void options;
`);
  compileStrictUnusedSdk(output, [assertFile]);
  const links = requireRecord(await import(pathToFileURL(path.join(output, 'dist/links.js')).href), 'links module');
  assert.deepEqual(links.responseLinks, { getA: { 200: { toB: { operationId: 'getB', parameters: {} } } } });
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
  await generateMaterializedSdk({
    openapi: '3.2.0', info: info('Shared'),
    paths: { '/items/{id}': { get: {
      operationId: 'getItem',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'item', content: { 'application/json': { schema: { type: 'object' } } } } },
    } } },
  }, { output, name: 'Shared', profile: { mobx: false, validation: true } });
  compileStrictUnusedSdk(output);
  const Client = (await importClient(output, 'shared client')).SharedClient;
  assert.ok(isGeneratedClientClass(Client));
  if (!isGeneratedClientClass(Client)) throw new TypeError('SharedClient');
  const client = new Client({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
  });
  // The brand of an undeclared-response error belongs to the package's runtime; a copied runtime has its own.
  const error = await client.getItem().execute({ path: { id: 'a' } }).then(() => undefined, (cause: unknown) => cause);
  assert.ok(isUndeclaredResponseError(error));
});

test('minimal GET without content omits codec options and unused helpers', async (t) => {
  await assertFilesPerProfile(t, pingDocument(), 'Ping', (profile) => [
    'index.ts',
    'types.ts',
    'model-manifest.json',
    'client.ts',
    'operations/ping.ts',
    ...(profile.validation ? ['validators.generated.ts'] : []),
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

test('stream and mutual-TLS surfaces are emitted when an operation uses them', async (t) => {
  const itemSchema = { type: 'object', properties: { id: { type: 'integer' } } };
  const output = outputDir(t, 'stream-security-surfaces');
  await generateMaterializedSdk({
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
  }, { output, name: 'StreamSecurity', profile: { mobx: false, validation: false } });
  const assertFile = writeAssertFile(output, 'surfaces-assert.ts', `import type {
  StreamSecurityClientOptions,
  StreamSecurityMutualTlsTransport,
  StreamSecurityStreamDecoder,
} from './client.js';
const decoder: StreamSecurityStreamDecoder = async function* () { yield { id: 1 }; };
const transport: StreamSecurityMutualTlsTransport = { fetchImpl: fetch };
const options: StreamSecurityClientOptions = {
  baseUrl: 'https://example.test',
  auth: { bearer: 'token' },
  mutualTls: transport,
  streamDecoders: { 'application/x-custom': decoder },
};
void options;
`);
  compileStrictUnusedSdk(output, [assertFile]);
  const Client = (await importClient(output, 'stream security client')).StreamSecurityClient;
  assert.ok(isGeneratedClientClass(Client));
  if (!isGeneratedClientClass(Client)) throw new TypeError('StreamSecurityClient');
  const events = () => new Response('{"id":1}\n', { headers: { 'content-type': 'application/x-ndjson' } });
  const rows = () => new Response('\u001e{"id":1}\n', { headers: { 'content-type': 'application/json-seq' } });
  const bearerRequests: Array<string | null> = [];
  const bearerClient = new Client({
    baseUrl: 'https://fixture.invalid',
    auth: { bearer: 'token' },
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      bearerRequests.push(new Headers(init?.headers).get('authorization'));
      return events();
    },
  });
  await bearerClient.events().execute({});
  assert.deepEqual(bearerRequests, ['Bearer token']);

  // A mutualTLS transport replaces fetchImpl for every request; a client without one cannot satisfy the requirement.
  const transported: string[] = [];
  const mutualClient = new Client({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async () => { throw new Error('fetchImpl must not carry a mutualTLS request'); },
    mutualTls: { fetchImpl: async (url: RequestInfo | URL) => { transported.push(new URL(String(url)).pathname); return rows(); } },
  });
  await mutualClient.rows().execute({});
  assert.deepEqual(transported, ['/rows']);
  const plainClient = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => rows() });
  await assert.rejects(plainClient.rows().execute({}), /No configured credentials satisfy the operation security requirements/);
});

test('an operation with no effective security requirement sends no credentials and resolves none, and the others keep theirs', async t => {
  const output = outputDir(t, 'unsecured-operations');
  const respond = { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } };
  await generateMaterializedSdk({
    openapi: '3.1.0',
    info: info('Unsecured'),
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths: {
      '/inherits': { get: { operationId: 'inherits', responses: respond } },
      '/open': { get: { operationId: 'open', security: [], responses: respond } },
      '/optional': { get: { operationId: 'optionalAuth', security: [{}], responses: respond } },
    },
  }, { output, name: 'Unsecured', profile: { mobx: false, validation: false } });
  compileStrictUnusedSdk(output);

  const module = await importClient(output, 'unsecured client');
  const Client = module.UnsecuredClient;
  assert.ok(isGeneratedClientClass(Client));
  // The client merges the scheme metadata of every operation module, including the one that needs none.
  assert.deepEqual(module.unsecuredSecuritySchemeMetadata, { bearer: { type: 'http', scheme: 'bearer' } });
  const seen: Record<string, string | null> = {};
  const fetchImpl: typeof fetch = async (url, init) => {
    seen[new URL(String(url)).pathname] = new Headers(init?.headers).get('authorization');
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const resolved: string[] = [];
  const bearer = (context: { scheme: string }) => { resolved.push(context.scheme); return 'secret'; };
  const client = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl, auth: { bearer } });
  await client.open().execute({});
  await client.inherits().execute({});
  await client.optionalAuth().execute({});
  // An empty requirement object makes authentication optional and names no scheme to apply.
  assert.deepEqual(seen, { '/open': null, '/inherits': 'Bearer secret', '/optional': null });
  assert.deepEqual(resolved, ['bearer'], 'only the operation that inherits the requirement resolves a credential');
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
  // One file per model and no facade module between the entry and them.
  assert.deepEqual(emittedFiles(result.artifacts, output).filter(file => !file.startsWith('models/_group-')), [
    'index.ts', 'input-schemas.ts', 'model-manifest.json', 'models/Money.ts', 'models/Payment.ts', 'output-schemas.ts', 'types.ts',
  ]);
  compileStrictUnusedSdk(output);
  const entry = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'SDK entry');
  const assertDirect = async (name: string): Promise<void> => {
    const direct = requireRecord(await import(pathToFileURL(path.join(output, `dist/models/${name}.js`)).href), `${name} module`);
    assert.ok(isGeneratedModelClass(entry[`${name}Model`]), `${name}Model is a model class`);
    assert.strictEqual(entry[`${name}Model`], direct[`${name}Model`]);
  };
  await assertDirect('Money');
  await assertDirect('Payment');
});

test('a validation SDK with operations compiles under strict unused checks', async t => {
  const output = outputDir(t, 'validation-strict');
  await generateMaterializedSdk({
    openapi: '3.1.0', info: info('Strict'),
    components: { schemas: { Item: {
      type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } },
    } } },
    paths: { '/items': { post: {
      operationId: 'createItem',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
    } } },
  }, { output, name: 'Strict', profile: { mobx: false, validation: true } });
  compileStrictUnusedSdk(output);
});

test('an operation module declares only the request locals it uses', async t => {
  const output = outputDir(t, 'operation-locals');
  await generateMaterializedSdk({
    openapi: '3.1.0', info: info('Locals'),
    paths: {
      '/plain': { get: { operationId: 'plain', responses: { 204: { description: 'ok' } } } },
      '/session': {
        get: {
          operationId: 'session',
          parameters: [{ name: 'sid', in: 'cookie', schema: { type: 'string' } }],
          responses: { 204: { description: 'ok' } },
        },
      },
    },
  }, { output, name: 'Locals', profile: { mobx: false, validation: false } });
  // Unused locals fail the strict compile; the behavior is the request each module builds.
  compileStrictUnusedSdk(output);
  const Client = (await importClient(output, 'locals client')).LocalsClient;
  assert.ok(isGeneratedClientClass(Client));
  if (!isGeneratedClientClass(Client)) throw new TypeError('LocalsClient');
  const requests: Array<{ url: string; cookie: string | null }> = [];
  const client = new Client({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), cookie: new Headers(init?.headers).get('cookie') });
      return new Response(null, { status: 204 });
    },
  });
  await client.plain().execute({});
  await client.session().execute({ cookie: { sid: 'abc' } });
  assert.deepEqual(requests, [
    { url: 'https://fixture.invalid/plain', cookie: null },
    { url: 'https://fixture.invalid/session', cookie: 'sid=abc' },
  ]);
});

test('SDK model functions use the model types instead of unknown', async t => {
  const output = outputDir(t, 'typed-functions');
  await generateMaterializedSdk({
    openapi: '3.1.0', info: info('Typed'), paths: {},
    components: { schemas: { Money: { type: 'object', properties: { amount: { type: 'string' } }, required: ['amount'] } } },
  }, { output, name: 'Typed', profile: { mobx: false, validation: true } });
  const assertFile = writeAssertFile(output, 'functions-assert.ts', `import { parseMoney, toWireFormatMoney, validateMoney, type MoneyFields } from './index.js';
import type * as Types from './types.js';
type IsAny<T> = 0 extends 1 & T ? true : false;
const returnsAny: IsAny<ReturnType<typeof parseMoney>> = false;
const parsed: MoneyFields = parseMoney('{"amount":"1"}');
const wire: Types.Money = toWireFormatMoney(parsed);
declare const input: unknown;
if (validateMoney(input)) {
  const narrowed: MoneyFields = input;
  void narrowed;
}
// @ts-expect-error toWireFormatMoney takes a model value, not unknown
void toWireFormatMoney(input);
void wire;
void returnsAny;
`);
  compileStrictUnusedSdk(output, [assertFile]);
  const { parseMoney, toWireFormatMoney, validateMoney } = await import(pathToFileURL(path.join(output, 'dist/index.js')).href) as {
    parseMoney(text: string): unknown;
    toWireFormatMoney(value: unknown): unknown;
    validateMoney(value: unknown): boolean;
  };
  const money: unknown = parseMoney('{"amount":"5"}');
  assert.equal(validateMoney(money), true);
  assert.equal(validateMoney({}), false);
  assert.deepEqual(toWireFormatMoney(money), { amount: '5' });
});
