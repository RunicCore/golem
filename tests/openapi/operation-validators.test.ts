import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { ClientRuntime } from '@exprtlabs/golem/client';
import { IssueRepresentation, IssueSource, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { operationValidators } from '@exprtlabs/golem/validation';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import { writeSdk } from '#openapi/generator';
import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, isGeneratedClientClass, writeGeneratedSdk, type GeneratedClientClass } from './helpers.js';

/** The one POST /payload operation that takes and returns the Payload component. */
function payloadPaths(): Record<string, unknown> {
  return { '/payload': { post: {
    operationId: 'sendPayload',
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' } } } } },
  } } };
}

function sdkDocument(marker: string): Record<string, unknown> {
  return {
    openapi: '3.1.0', info: { title: 'Engine', version: '1' },
    components: { schemas: { Payload: {
      $id: 'urn:sdk-engine-test:payload',
      type: 'object', required: ['marker'], properties: { marker: { const: marker, type: 'string' } }, additionalProperties: false,
    } } },
    paths: payloadPaths(),
  };
}

type PayloadClient = { sendPayload(): { execute(input: { body: { marker: string } }): Promise<{ body: unknown }> } };

// One generate and compile per marker: the tests share the loaded client class and each builds its own clients.
const payloadClasses = new Map<string, Promise<GeneratedClientClass>>();
const payloadRoot = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'golem-sdk-validators-')));
after(() => fs.rmSync(payloadRoot, { recursive: true, force: true }));

function loadPayloadClass(marker: string): Promise<GeneratedClientClass> {
  const cached = payloadClasses.get(marker);
  if (cached) return cached;
  const loaded = generatePayloadClass(marker);
  payloadClasses.set(marker, loaded);
  return loaded;
}

async function generatePayloadClass(marker: string): Promise<GeneratedClientClass> {
  const output = path.join(payloadRoot, marker);
  writeGeneratedSdk(writeSdk, sdkDocument(marker), { output, name: 'Engine', profile: { mobx: false, validation: true } });
  compileGeneratedSdk(output, []);
  const module: Record<string, unknown> = await import(pathToFileURL(path.join(output, 'dist/client.js')).href);
  const Client = module.EngineClient;
  assert.ok(isGeneratedClientClass(Client));
  return Client;
}

async function loadSdk(marker: string, fetchImpl?: typeof fetch): Promise<PayloadClient> {
  const Client = await loadPayloadClass(marker);
  return new Client({ baseUrl: 'https://fixture.invalid', ...(fetchImpl ? { fetchImpl } : {}) }) as unknown as PayloadClient;
}

const echo: typeof fetch = async (_url, init) =>
  new Response(String(init?.body), { headers: { 'content-type': 'application/json' } });

test('SDKs in one process validate with their own generated validators', async () => {
  const clients = { A: await loadSdk('A', echo), B: await loadSdk('B', echo) };
  for (const [marker, client] of Object.entries(clients)) {
    const other = marker === 'A' ? 'B' : 'A';
    assert.deepEqual((await client.sendPayload().execute({ body: { marker } })).body, { marker });
    await assert.rejects(client.sendPayload().execute({ body: { marker: other } }), `SDK ${marker} rejects ${other}`);
  }
});

test('an operation input that fails its schema is rejected with the issue before any request', async () => {
  let requests = 0;
  const client = await loadSdk('A', async (url, init) => { requests++; return echo(url, init); });
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

test('a response body that fails its schema is rejected for its status and content type', async () => {
  const client = await loadSdk('A', async () => new Response(JSON.stringify({ marker: 'B' }), { headers: { 'content-type': 'application/json' } }));
  const error = await client.sendPayload().execute({ body: { marker: 'A' } }).then(() => undefined, (rejected: unknown) => rejected);
  assert.ok(error instanceof LibError);
  assert.equal(error.kind, LibErrorKind.Validation);
  assert.deepEqual(error.issues.map((issue) => [issue.code, issue.path]), [['literal', ['marker']]]);
});

test('a validator override on one client leaves other clients of the same generated SDK on the generated validators', async () => {
  // protects: F-139 a validator override on one client never reaches another client's validators
  const Client = await loadPayloadClass('S');
  const rejectAll: Validator = () => [{ code: 'custom', path: [] }];
  const overrides = new Map([['sendPayload', { input: rejectAll, responses: new Map() }]]);
  const overridden = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl: echo, operationValidators: overrides }) as unknown as PayloadClient;
  const generated = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl: echo }) as unknown as PayloadClient;
  await assert.rejects(overridden.sendPayload().execute({ body: { marker: 'S' } }), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
  assert.deepEqual((await generated.sendPayload().execute({ body: { marker: 'S' } })).body, { marker: 'S' });
  await assert.rejects(generated.sendPayload().execute({ body: { marker: 'A' } }), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
});

test('a validator override replaces the generated validators of its operation', async () => {
  const Client = await loadPayloadClass('S');
  const rejectAll: Validator = () => [{ code: 'custom', path: [] }];
  const accept: Validator = () => [];
  const overrides = new Map([['sendPayload', { input: rejectAll, responses: new Map([['200:application/json', accept]]) }]]);
  const client = new Client({ baseUrl: 'https://fixture.invalid', fetchImpl: echo, operationValidators: overrides }) as unknown as PayloadClient;
  await assert.rejects(client.sendPayload().execute({ body: { marker: 'S' } }), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
});

test('an override that does not return an array of issues is refused, never read as valid', async () => {
  const Client = await loadPayloadClass('S');
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

test('the generated validators of an operation are keyed by status and content type, and resolved once per runtime', () => {
  const runtime = new ClientRuntime('Engine', { baseUrl: 'https://fixture.invalid' });
  const input: Validator = () => [];
  const ok: Validator = () => [];
  const problem: Validator = () => [];
  const sources = {
    input,
    responses: [
      { status: '200', contentType: 'application/json', validator: ok },
      { status: '400', contentType: 'application/problem+json', validator: problem },
    ],
  };
  const resolved = operationValidators(runtime, 'sendPayload', sources);
  assert.equal(resolved.input, input);
  assert.deepEqual([...resolved.responses], [['200:application/json', ok], ['400:application/problem+json', problem]]);
  assert.equal(operationValidators(runtime, 'sendPayload', { input: ok, responses: [] }), resolved, 'the first resolution is kept');
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
    paths: payloadPaths(),
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

test('an OpenAPI format golem does not check stops generation by default, and unknownFormats: warn warns and writes the files', () => {
  // protects: T-33 unknownFormats defaults to error; warn is the opt-out
  const document = {
    openapi: '3.1.0', info: { title: 'Ledger', version: '1' },
    components: { schemas: { Amount: { type: 'string', format: 'money' } } },
    paths: { '/credit': { post: {
      operationId: 'credit',
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Amount' } } } },
      responses: { 200: { description: 'ok' } },
    } } },
  };
  const output = path.join(tmpdir(), 'golem-unknown-format-default');
  const stopped = writeSdk(document, { output, name: 'Ledger', profile: { mobx: false, validation: true } });
  assert.deepEqual(stopped.artifacts, []);
  assert.deepEqual(
    (stopped.diagnostics ?? []).filter(entry => entry.code === 'VALIDATE_UNKNOWN_FORMAT').map(entry => entry.severity),
    [GolemDiagnosticSeverity.Error],
  );
  assert.match((stopped.diagnostics ?? [])[0]?.message ?? '', /the format "money" is not implemented, so golem cannot check it\./);
  const warned = writeSdk(document, { output, name: 'Ledger', profile: { mobx: false, validation: true, unknownFormats: 'warn' } });
  assert.ok(warned.artifacts.some(artifact => artifact.path === path.join(output, 'validators.generated.ts')), 'the warned run writes the SDK validators');
  assert.ok((warned.diagnostics ?? []).some(entry => entry.code === 'VALIDATE_UNKNOWN_FORMAT' && entry.severity === GolemDiagnosticSeverity.Warning));
});

test('an unknown format in an inline operation schema is reported with the operation name, not a crash', () => {
  // protects: T-290 the place of an inline operation schema is a message built from a Code value
  const document = {
    openapi: '3.1.0', info: { title: 'Ledger', version: '1' },
    paths: { '/credit': { post: {
      operationId: 'credit',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'string', format: 'money' } } } },
      responses: { 200: { description: 'ok' } },
    } } },
  };
  const output = path.join(tmpdir(), 'golem-unknown-format-inline');
  const stopped = writeSdk(document, { output, name: 'Ledger', profile: { mobx: false, validation: true } });
  assert.deepEqual(stopped.artifacts, []);
  const errors = (stopped.diagnostics ?? []).filter(entry => entry.code === 'VALIDATE_UNKNOWN_FORMAT');
  assert.deepEqual(errors.map(entry => entry.severity), [GolemDiagnosticSeverity.Error]);
  assert.match(errors[0].message, /^operation "credit" at \/input\/properties\/body\/format: /);
  const warned = writeSdk(document, { output, name: 'Ledger', profile: { mobx: false, validation: true, unknownFormats: 'warn' } });
  assert.ok(warned.artifacts.some(artifact => artifact.path === path.join(output, 'validators.generated.ts')), 'the warned run writes the SDK validators');
  assert.ok((warned.diagnostics ?? []).some(entry => entry.code === 'VALIDATE_UNKNOWN_FORMAT' && entry.severity === GolemDiagnosticSeverity.Warning));
});

test('writeSdk reports each standard keyword with a wrong shape that a document never checked holds, and writes no files', () => {
  // protects: T-486 a wrong-shape standard keyword is an error, not a looser validator
  const schema = { type: 'object', properties: {
    kind: { type: 'integr' }, tag: { enum: 'a' }, name: { type: 'string', minLength: '3' }, code: { type: 'string', pattern: 5 },
  } };
  const document = {
    openapi: '3.1.0', info: { title: 'Shapes', version: '1' },
    paths: { '/a': { post: { operationId: 'send', requestBody: { content: { 'application/json': { schema } } }, responses: { 200: { description: 'ok' } } } } },
  };
  const result = writeSdk(document, { output: path.join(tmpdir(), 'golem-wrong-shapes'), profile: { mobx: false, validation: true } });
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual((result.diagnostics ?? []).map(entry => [entry.code, entry.severity, entry.message]), [
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, 'operation "send" at /input/properties/body/properties/kind/type: the value of type is not valid: expected a type name or a non-empty list of type names (string, number, integer, boolean, null, object, array)'],
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, 'operation "send" at /input/properties/body/properties/tag/enum: the value of enum is not valid: expected a list'],
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, 'operation "send" at /input/properties/body/properties/name/minLength: the value of minLength is not valid: expected a non-negative integer'],
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, 'operation "send" at /input/properties/body/properties/code/pattern: the value of pattern is not valid: expected a string'],
  ]);
});

test('writeSdk reports each schema keyword that holds a value that is no schema, and writes no files', () => {
  // protects: T-509 a schema keyword with a non-schema value is an error, not a looser or a rejecting validator
  const schema = { type: 'object', properties: {
    list: { items: 5 }, wanted: { contains: 'x' }, other: { not: 5 }, extra: { additionalProperties: 'x' }, cond: { if: 3 }, branch: { allOf: [true, 7] },
  } };
  const document = {
    openapi: '3.1.0', info: { title: 'Schemas', version: '1' },
    paths: { '/a': { post: { operationId: 'send', requestBody: { content: { 'application/json': { schema } } }, responses: { 200: { description: 'ok' } } } } },
  };
  const result = writeSdk(document, { output: path.join(tmpdir(), 'golem-non-schema-values'), profile: { mobx: false, validation: true } });
  assert.deepEqual(result.artifacts, []);
  const expected = 'expected a boolean or a schema object';
  assert.deepEqual((result.diagnostics ?? []).map(entry => [entry.code, entry.severity, entry.message]), [
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, `operation "send" at /input/properties/body/properties/list/items: the value of items is not valid: ${expected}`],
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, `operation "send" at /input/properties/body/properties/wanted/contains: the value of contains is not valid: ${expected}`],
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, `operation "send" at /input/properties/body/properties/other/not: the value of not is not valid: ${expected}`],
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, `operation "send" at /input/properties/body/properties/extra/additionalProperties: the value of additionalProperties is not valid: ${expected}`],
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, `operation "send" at /input/properties/body/properties/cond/if: the value of if is not valid: ${expected}`],
    ['VALIDATE_UNSUPPORTED_KEYWORD', GolemDiagnosticSeverity.Error, `operation "send" at /input/properties/body/properties/branch/allOf/1: the value of allOf is not valid: ${expected}`],
  ]);
});
