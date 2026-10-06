import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ClientRuntime } from '@exprtlabs/golem/client';
import { IssueRepresentation, IssueSource, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { operationValidators, type OperationRuntimeValidators } from '@exprtlabs/golem/validation';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
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

async function loadSdk(root: string, marker: string, fetchImpl?: typeof fetch): Promise<PayloadClient> {
  const output = path.join(root, marker);
  writeGeneratedSdk(writeSdk, sdkDocument(marker), { output, name: 'Engine', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.EngineClient;
  assert.ok(isGeneratedClientClass(Client));
  return new Client({ baseUrl: 'https://fixture.invalid', ...(fetchImpl ? { fetchImpl } : {}) }) as unknown as PayloadClient;
}

const echo: typeof fetch = async (_url, init) =>
  new Response(String(init?.body), { headers: { 'content-type': 'application/json' } });

test('SDKs in one process validate with their own generated validators', async (t) => {
  const root = createFixtureProject(t, 'golem-sdk-validators-');
  const clients = { A: await loadSdk(root, 'A', echo), B: await loadSdk(root, 'B', echo) };
  for (const [marker, client] of Object.entries(clients)) {
    const other = marker === 'A' ? 'B' : 'A';
    assert.deepEqual((await client.sendPayload().execute({ body: { marker } })).body, { marker });
    await assert.rejects(client.sendPayload().execute({ body: { marker: other } }), `SDK ${marker} rejects ${other}`);
  }
});

test('an operation input that fails its schema is rejected with the issue before any request', async (t) => {
  const root = createFixtureProject(t, 'golem-sdk-input-issue-');
  let requests = 0;
  const client = await loadSdk(root, 'A', async (url, init) => { requests++; return echo(url, init); });
  const error = await client.sendPayload().execute({ body: { marker: 'B' } }).then(() => undefined, (rejected: unknown) => rejected);
  assert.ok(error instanceof LibError);
  assert.equal(error.kind, LibErrorKind.Validation);
  assert.deepEqual(error.issues, [{
    code: 'literal',
    expected: ['A'],
    path: ['body', 'marker'],
    message: 'Must be "A"',
    source: IssueSource.OpenAPI,
    representation: IssueRepresentation.Wire,
  }]);
  assert.equal(requests, 0, 'invalid input never reaches transport');
});

test('a response body that fails its schema is rejected for its status and content type', async (t) => {
  const root = createFixtureProject(t, 'golem-sdk-response-issue-');
  const client = await loadSdk(root, 'A', async () => new Response(JSON.stringify({ marker: 'B' }), { headers: { 'content-type': 'application/json' } }));
  const error = await client.sendPayload().execute({ body: { marker: 'A' } }).then(() => undefined, (rejected: unknown) => rejected);
  assert.ok(error instanceof LibError);
  assert.equal(error.kind, LibErrorKind.Validation);
  assert.deepEqual(error.issues.map((issue) => [issue.code, issue.path]), [['literal', ['marker']]]);
});

test('a generated client needs no validation engine and operations share one validators module', async (t) => {
  const output = path.join(createFixtureProject(t, 'golem-sdk-no-engine-'), 'S');
  writeGeneratedSdk(writeSdk, sdkDocument('S'), { output, name: 'Engine', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.EngineClient;
  assert.ok(isGeneratedClientClass(Client));
  const validatorsOf = (client: PayloadClient): OperationRuntimeValidators => {
    client.sendPayload();
    const runtime: unknown = Reflect.get(client, 'runtime');
    if (!(runtime instanceof ClientRuntime)) throw new TypeError('the generated client holds a ClientRuntime');
    const validators = runtime.operationValidatorCache.get('sendPayload');
    assert.ok(validators);
    return validators;
  };
  const first = validatorsOf(new Client({ baseUrl: 'https://fixture.invalid' }) as unknown as PayloadClient);
  const second = validatorsOf(new Client({ baseUrl: 'https://fixture.invalid' }) as unknown as PayloadClient);
  assert.equal(second.input, first.input, 'both runtimes use the validators of one generated module');
});

test('a validator override replaces the generated validators of its operation', async (t) => {
  const output = path.join(createFixtureProject(t, 'golem-sdk-override-'), 'S');
  writeGeneratedSdk(writeSdk, sdkDocument('S'), { output, name: 'Engine', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.EngineClient;
  assert.ok(isGeneratedClientClass(Client));
  const rejectAll: Validator = () => [{ code: 'custom', path: [] }];
  const accept: Validator = () => [];
  const overrides = new Map([['sendPayload', { input: rejectAll, responses: new Map([['200:application/json', accept]]) }]]);
  const client = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl: echo, operationValidators: overrides }) as unknown as PayloadClient;
  await assert.rejects(client.sendPayload().execute({ body: { marker: 'S' } }), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
});

test('an override that does not return an array of issues is refused, never read as valid', async (t) => {
  const output = path.join(createFixtureProject(t, 'golem-sdk-override-contract-'), 'S');
  writeGeneratedSdk(writeSdk, sdkDocument('S'), { output, name: 'Engine', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.EngineClient;
  assert.ok(isGeneratedClientClass(Client));
  const oldStyle = new Map([['sendPayload', { input: () => true, responses: new Map() }]]);
  const client = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl: echo, operationValidators: oldStyle }) as unknown as PayloadClient;
  await assert.rejects(
    client.sendPayload().execute({ body: { marker: 'S' } }),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Validation
      && error.cause instanceof TypeError
      && error.cause.message === 'A validator must return an array of issues.',
  );
});

test('an operation named validators generates, compiles and validates', async (t) => {
  const document = {
    openapi: '3.1.0', info: { title: 'Named', version: '1' },
    paths: { '/validators': { post: {
      operationId: 'validators',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } },
      responses: { 204: { description: 'ok' } },
    } } },
  };
  const output = path.join(createFixtureProject(t, 'golem-sdk-validators-name-'), 'N');
  writeGeneratedSdk(writeSdk, document, { output, name: 'Named', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.NamedClient;
  assert.ok(isGeneratedClientClass(Client));
  const client = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => new Response(null, { status: 204 }) });
  await assert.doesNotReject(() => client.validators().execute({ body: { id: 1 } }));
  await assert.rejects(() => client.validators().execute({ body: { id: 'x' } }), /validation failed/i);
});

test('responses declared by a status range or default, with a parametric content type, are validated', async (t) => {
  const body = { 'application/json; charset=utf-8': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } };
  const document = {
    openapi: '3.1.0', info: { title: 'Ranges', version: '1' },
    paths: {
      '/range': { get: { operationId: 'getRange', responses: { '2XX': { description: 'ok', content: body } } } },
      '/fallback': { get: { operationId: 'getFallback', responses: { default: { description: 'any', content: body } } } },
    },
  };
  const output = path.join(createFixtureProject(t, 'golem-sdk-ranges-'), 'R');
  writeGeneratedSdk(writeSdk, document, { output, name: 'Ranges', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.RangesClient;
  assert.ok(isGeneratedClientClass(Client));
  const respond = (status: number, payload: unknown) => new Client({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }),
  });
  assert.deepEqual((await respond(201, { id: 1 }).getRange().execute({})).body, { id: 1 });
  await assert.rejects(() => respond(201, { id: 'x' }).getRange().execute({}), /validation failed/i);
  assert.deepEqual((await respond(500, { id: 2 }).getFallback().execute({})).body, { id: 2 });
  await assert.rejects(() => respond(500, { id: 'x' }).getFallback().execute({}), /validation failed/i);
});

test('an operation without a generated validator is reported by operation, never skipped', () => {
  const runtime = new ClientRuntime('Engine', { baseUrl: 'https://fixture.invalid' });
  const accept: Validator = () => [];
  const sources = {
    inputReference: 'input',
    responseReferences: [{ status: '200', contentType: 'application/json', reference: 'ok' }],
  };
  assert.throws(
    () => operationValidators(runtime, 'sendPayload', { ...sources, validators: {} }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable && /operation input: sendPayload/.test(error.message),
  );
  assert.throws(
    () => operationValidators(runtime, 'sendPayload', { ...sources, validators: { input: accept } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable && /operation response: sendPayload 200 application\/json/.test(error.message),
  );
});

test('a discriminated response is validated against the variant its tag selects', async (t) => {
  const document = {
    openapi: '3.1.0', info: { title: 'Pets', version: '1' },
    components: { schemas: {
      Cat: { type: 'object', required: ['kind', 'name'], properties: { kind: { type: 'string' }, name: { type: 'string' } } },
      Dog: { type: 'object', required: ['kind', 'bark'], properties: { kind: { type: 'string' }, bark: { type: 'boolean' } } },
      Pet: {
        oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
        discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } },
      },
    } },
    paths: { '/pet': { get: {
      operationId: 'getPet',
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
    } } },
  };
  const output = path.join(createFixtureProject(t, 'golem-sdk-response-variants-'), 'P');
  writeGeneratedSdk(writeSdk, document, { output, name: 'Pets', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.PetsClient;
  assert.ok(isGeneratedClientClass(Client));
  const respond = (body: unknown) => new Client({
    baseUrl: 'https://fixture.invalid',
    fetchImpl: async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
  });
  const outcomes: Record<string, boolean> = {};
  for (const [name, body] of Object.entries({
    cat: { kind: 'cat', name: 'Miso' },
    dog: { kind: 'dog', bark: true },
    dogTagWithCatFields: { kind: 'dog', name: 'Miso' },
    unknownTag: { kind: 'bird', name: 'Miso' },
  })) {
    outcomes[name] = await respond(body).getPet().execute({}).then(() => true, () => false);
  }
  assert.deepEqual(outcomes, { cat: true, dog: true, dogTagWithCatFields: false, unknownTag: false });
});

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

test('same-title SDKs keep their schema contracts', async t => {
  const root = createFixtureProject(t, 'golem-openapi-shared-title-');
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
    const client = new module.SharedClient({ baseUrl: 'https://fixture.invalid', fetchImpl });
    const result = await client.sendPayload().execute({ body: { marker } });
    assert.deepEqual(result.body, { marker });
    const before = requests;
    await assert.rejects(client.sendPayload().execute({ body: { marker: marker === 'A' ? 'B' : 'A' } }));
    assert.equal(requests, before, 'invalid input never reaches transport');
  }
});

test('a format golem does not check is reported once for the component, however many operations use it', () => {
  const amount = { $ref: '#/components/schemas/Amount' };
  const operation = (operationId: string) => ({ post: {
    operationId,
    requestBody: { required: true, content: { 'application/json': { schema: amount } } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: amount } } } },
  } });
  const document = {
    openapi: '3.1.0', info: { title: 'Ledger', version: '1' },
    components: { schemas: { Amount: { type: 'string', format: 'money' } } },
    paths: { '/credit': operation('credit'), '/debit': operation('debit'), '/refund': operation('refund') },
  };
  const result = writeSdk(document, { output: path.join(tmpdir(), 'golem-unknown-format-once'), name: 'Ledger', profile: { mobx: false, validation: true, unknownFormats: 'warn' } });
  const warnings = (result.diagnostics ?? []).filter(entry => entry.code === 'VALIDATE_UNKNOWN_FORMAT');
  assert.equal(warnings.length, 1, JSON.stringify(warnings, null, 1));
  assert.match(warnings[0].message, /#\/components\/schemas\/Amount\/format/);
  assert.match(warnings[0].message, /"money"/);
  assert.doesNotMatch(warnings[0].message, /urn:golem|Amount_[0-9a-f]{8}/);
  assert.equal(warnings[0].file, undefined);
  assert.equal(warnings[0].path, '#/components/schemas/Amount/format');
});

test('a format golem does not check is reported at the component key, however the model is named', () => {
  const item = { $ref: '#/components/schemas/pet-item' };
  const document = {
    openapi: '3.1.0', info: { title: 'Pets', version: '1' },
    components: { schemas: { 'pet-item': { type: 'object', properties: { price: { type: 'string', format: 'money' } } } } },
    paths: { '/items': { post: {
      operationId: 'addItem',
      requestBody: { required: true, content: { 'application/json': { schema: item } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: item } } } },
    } } },
  };
  const result = writeSdk(document, { output: path.join(tmpdir(), 'golem-unknown-format-key'), name: 'Pets', profile: { mobx: false, validation: true, unknownFormats: 'warn' } });
  const warnings = (result.diagnostics ?? []).filter(entry => entry.code === 'VALIDATE_UNKNOWN_FORMAT');
  assert.ok(warnings.length > 0);
  for (const warning of warnings) assert.ok(warning.path?.startsWith('#/components/schemas/pet-item'), JSON.stringify(warning));
});
