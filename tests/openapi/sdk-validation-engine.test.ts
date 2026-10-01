import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { createOpenApiAjvEngine } from '@exprtlabs/golem/ajv';
import { ClientRuntime } from '@exprtlabs/golem/client';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
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

async function loadSdk(root: string, marker: string, profile: GolemProfile): Promise<PayloadClient> {
  const output = path.join(root, marker);
  writeGeneratedSdk(writeSdk, sdkDocument(marker), { output, name: 'Engine', profile });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.EngineClient;
  assert.ok(isGeneratedClientClass(Client));
  const options = { baseUrl: 'https://fixture.invalid' };
  const engineOf = (client: object): unknown => {
    const runtime: unknown = Reflect.get(client, 'runtime');
    if (!(runtime instanceof ClientRuntime)) throw new TypeError('the generated client holds a shared ClientRuntime');
    return runtime.validationEngine;
  };
  const shared = engineOf(new Client(options));
  const index: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/index.js')).href);
  for (const internal of ['createRuntimeValidators', 'createOperationRuntimeValidators', 'schemaRegistry', 'schemaId', 'IOBJECT_PLUGIN_KEYS']) {
    assert.equal(internal in index, false, `${internal} is internal to the SDK`);
  }
  for (const name of ['schemas.ts', 'validation-engine.ts', 'validators.generated.js']) {
    assert.equal(existsSync(path.join(output, name)), false, `no SDK emits ${name}`);
  }
  if (profile.ajvStandalone) {
    assert.equal(shared, undefined);
    assert.equal(existsSync(path.join(output, 'operations/sendPayload.validators.generated.js')), true, 'a standalone SDK validates with per-operation validators');
  } else {
    assert.equal(existsSync(path.join(output, 'operations/sendPayload.validators.generated.js')), false);
    assert.ok(shared);
    assert.equal(engineOf(new Client(options)), shared, 'clients of one SDK share one default engine');
  }
  const supplied = { addSchema() {}, getSchema() { return undefined; } };
  assert.equal(engineOf(new Client({ ...options, validationEngine: supplied })), supplied);
  const fetchImpl: typeof fetch = async (_url, init) =>
    new Response(String(init?.body), { headers: { 'content-type': 'application/json' } });
  if (!profile.ajvStandalone) {
    const unusable = new Client({ ...options, validationEngine: supplied, fetchImpl }) as unknown as PayloadClient;
    await assert.rejects(
      async () => unusable.sendPayload().execute({ body: { marker } }),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
      'an engine that compiles no schema is reported, not silently skipped',
    );
    const inputOnly = { addSchema() {}, getSchema: (reference: string) => reference.includes('/input') ? Object.assign(() => true, { errors: null }) : undefined };
    const noResponses = new Client({ ...options, validationEngine: inputOnly, fetchImpl }) as unknown as PayloadClient;
    await assert.rejects(
      async () => noResponses.sendPayload().execute({ body: { marker } }),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable && /operation response: sendPayload/.test(error.message),
      'a response the engine cannot compile is reported by operation',
    );
  }
  return new Client({ baseUrl: 'https://fixture.invalid', fetchImpl }) as unknown as PayloadClient;
}

for (const ajvStandalone of [false, true]) {
  test(`SDK clients share one default validation engine and SDKs in one process keep their own schemas (${ajvStandalone ? 'standalone' : 'runtime Ajv'})`, async (t) => {
    const profile: GolemProfile = { mobx: false, validation: true, ajvStandalone };
    const root = createFixtureProject(t, 'golem-sdk-engine-');
    const clients = { A: await loadSdk(root, 'A', profile), B: await loadSdk(root, 'B', profile) };
    for (const [marker, client] of Object.entries(clients)) {
      const other = marker === 'A' ? 'B' : 'A';
      assert.deepEqual((await client.sendPayload().execute({ body: { marker } })).body, { marker });
      await assert.rejects(client.sendPayload().execute({ body: { marker: other } }), `SDK ${marker} rejects ${other}`);
    }
  });
}

for (const ajvStandalone of [false, true]) {
  test(`operation validation sources and standalone validators are built once per module (${ajvStandalone ? 'standalone' : 'runtime Ajv'})`, async (t) => {
    const root = createFixtureProject(t, 'golem-sdk-sources-');
    const output = path.join(root, 'S');
    writeGeneratedSdk(writeSdk, sdkDocument('S'), { output, name: 'Engine', profile: { mobx: false, validation: true, ajvStandalone } });
    compileGeneratedSdk(output, []);
    const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
    const Client = module.EngineClient;
    assert.ok(isGeneratedClientClass(Client));
    const options = { baseUrl: 'https://fixture.invalid' };
    if (ajvStandalone) {
      const validatorsOf = (client: PayloadClient): { input: unknown } => {
        client.sendPayload();
        const runtime: unknown = Reflect.get(client, 'runtime');
        if (!(runtime instanceof ClientRuntime)) throw new TypeError('the generated client holds a ClientRuntime');
        const validators = runtime.operationValidatorCache.get('sendPayload');
        assert.ok(validators);
        return validators;
      };
      const first = validatorsOf(new Client(options) as unknown as PayloadClient);
      const second = validatorsOf(new Client(options) as unknown as PayloadClient);
      assert.ok(first.input);
      assert.equal(second.input, first.input, 'both runtimes use the validators of one generated set');
      return;
    }
    const recorded = [new Map<string, unknown>(), new Map<string, unknown>()];
    for (const schemas of recorded) {
      const engine = {
        addSchema: (schema: unknown, id: string) => { schemas.set(id, schema); },
        getSchema: (reference: string) => [...schemas.keys()].some((id) => reference === id || reference.startsWith(`${id}#`))
          ? Object.assign(() => true, { errors: null })
          : undefined,
      };
      (new Client({ ...options, validationEngine: engine }) as unknown as PayloadClient).sendPayload();
    }
    assert.ok(recorded[0].size > 0, 'the operation hands its schemas to the engine');
    assert.deepEqual([...recorded[1].keys()], [...recorded[0].keys()]);
    for (const [id, schema] of recorded[0]) assert.strictEqual(recorded[1].get(id), schema, `${id} is the same schema object in both runtimes`);
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
  const root = createFixtureProject(t, 'golem-openapi-shared-title-');
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
