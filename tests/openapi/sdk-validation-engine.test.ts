import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { CodegenProfile } from '@exprtlabs/codegen/generator-api';
import { createOpenApiAjvEngine } from '@exprtlabs/codegen/ajv';
import { writeSdk } from '#openapi/generator';
import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, isGeneratedClientClass, writeGeneratedSdk } from './helpers.js';

function sdkDocument(marker: string): Record<string, unknown> {
  return {
    openapi: '3.1.0', info: { title: 'Engine', version: '1' },
    components: { schemas: { Payload: {
      $id: 'urn:sdk-engine-test:payload',
      type: 'object', required: ['marker'], properties: { marker: { const: marker, type: 'string' } }, additionalProperties: false,
    } } },
    paths: { '/payload': { post: {
      operationId: 'sendPayload',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } } } },
    } } },
  };
}

type PayloadClient = { sendPayload(): { execute(input: { body: { marker: string } }): Promise<{ body: unknown }> } };

async function loadSdk(root: string, marker: string, profile: CodegenProfile): Promise<PayloadClient> {
  const output = path.join(root, marker);
  writeGeneratedSdk(writeSdk, sdkDocument(marker), { output, name: 'Engine', profile });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const runtimeModule: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client-runtime.js')).href);
  const ClientRuntime = runtimeModule.ClientRuntime as new (options: object) => { readonly validationEngine: unknown };
  const options = { baseUrl: 'https://fixture.invalid' };
  const shared = new ClientRuntime(options).validationEngine;
  if (profile.ajvStandalone) assert.equal(shared, undefined);
  else {
    assert.ok(shared);
    assert.equal(new ClientRuntime(options).validationEngine, shared, 'operation factories share one default engine');
  }
  const supplied = { addSchema() {}, getSchema() { return undefined; } };
  assert.equal(new ClientRuntime({ ...options, validationEngine: supplied }).validationEngine, supplied);
  const Client = module.EngineClient;
  assert.ok(isGeneratedClientClass(Client));
  const fetchImpl: typeof fetch = async (_url, init) =>
    new Response(String(init?.body), { headers: { 'content-type': 'application/json' } });
  return new Client({ baseUrl: 'https://fixture.invalid', fetchImpl }) as unknown as PayloadClient;
}

for (const ajvStandalone of [false, true]) {
  test(`SDK clients share one default validation engine and SDKs in one process keep their own schemas (${ajvStandalone ? 'standalone' : 'runtime Ajv'})`, async (t) => {
    const profile: CodegenProfile = { mobx: false, validation: true, ajvStandalone };
    const root = createFixtureProject(t, 'fe-deps-sdk-engine-');
    const clients = { A: await loadSdk(root, 'A', profile), B: await loadSdk(root, 'B', profile) };
    for (const [marker, client] of Object.entries(clients)) {
      const other = marker === 'A' ? 'B' : 'A';
      assert.deepEqual((await client.sendPayload().execute({ body: { marker } })).body, { marker });
      await assert.rejects(client.sendPayload().execute({ body: { marker: other } }), `SDK ${marker} rejects ${other}`);
    }
  });
}

function sharedTitleDocument(marker: string): Record<string, unknown> {
  return {
    openapi: '3.1.0', info: { title: 'Shared title', version: '1' },
    components: { schemas: { Payload: {
      type: 'object', required: ['marker'], properties: { marker: { const: marker, type: 'string' } }, additionalProperties: false,
    } } },
    paths: { '/payload': { post: {
      operationId: 'sendPayload',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } } } },
    } } },
  };
}

test('same-title SDKs keep their schema contracts when they share a validation engine', async t => {
  const root = createFixtureProject(t, 'runic-openapi-shared-title-');
  const engine = createOpenApiAjvEngine();
  let requests = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    requests++;
    return new Response(String(init?.body), { headers: { 'content-type': 'application/json' } });
  };
  for (const marker of ['A', 'B']) {
    const output = path.join(root, marker);
    writeGeneratedSdk(writeSdk, sharedTitleDocument(marker), { output, name: 'Shared', profile: { mobx: false, validation: true } });
    compileGeneratedSdk(output, [], { strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true });
    const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
    assert.ok(isGeneratedClientClass(module.SharedClient));
    const client = new module.SharedClient({ baseUrl: 'https://fixture.invalid', fetchImpl, validationEngine: engine });
    const result = await client.sendPayload().execute({ body: { marker } });
    assert.deepEqual(result.body, { marker });
    const before = requests;
    await assert.rejects(client.sendPayload().execute({ body: { marker: marker === 'A' ? 'B' : 'A' } }));
    assert.equal(requests, before, 'invalid input never reaches transport');
  }
});

test('a standalone-engine SDK exposes createRuntimeValidators from its index and validates requests', async t => {
  const root = createFixtureProject(t, 'runic-openapi-standalone-validators-');
  const output = path.join(root, 'sdk');
  writeGeneratedSdk(writeSdk, sdkDocument('A'), { output, name: 'Engine', profile: { mobx: false, validation: true, ajvStandalone: true } });
  compileGeneratedSdk(output, []);
  const sdk: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/index.js')).href);
  assert.equal(typeof sdk.createRuntimeValidators, 'function');
  assert.equal(typeof sdk.createOperationRuntimeValidators, 'function');
  const Client = sdk.EngineClient;
  assert.ok(isGeneratedClientClass(Client));
  const fetchImpl: typeof fetch = async (_url, init) =>
    new Response(String(init?.body), { headers: { 'content-type': 'application/json' } });
  const client = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl }) as unknown as PayloadClient;
  assert.deepEqual((await client.sendPayload().execute({ body: { marker: 'A' } })).body, { marker: 'A' });
  await assert.rejects(client.sendPayload().execute({ body: { marker: 'B' } }));
});
