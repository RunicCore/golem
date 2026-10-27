import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import {
  captureRequest,
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  type GeneratedClientClass,
  requireRecord,
  type CapturedRequest,
} from './helpers.js';

const ping = { get: { operationId: 'ping', responses: { 204: { description: 'ok' } } } };

function twoServerDocument(): unknown {
  return {
    openapi: '3.2.0',
    info: { title: 'Servers', version: '1' },
    servers: [
      {
        url: 'https://{region}.api.example/{base}/',
        name: 'prod',
        description: 'Production',
        variables: { region: { default: 'eu', enum: ['eu', 'us'] }, base: { default: 'v1' } },
      },
      { url: 'https://staging.example/v2', description: 'Staging' },
      { url: 'https://decoy.example', description: 'prod' },
      { url: 'https://named.example', name: 'Staging' },
    ],
    paths: { '/ping': ping },
  };
}

async function loadSdk(t: TestContext, document: unknown, name: string, assertSource: string) {
  const output = path.join(createFixtureProject(t, 'golem-openapi-servers-'), 'sdk');
  await generateMaterializedSdk(document, { output, name, profile: { mobx: false, validation: false } });
  const assertFile = path.join(output, 'servers-assert.ts');
  writeFileSync(assertFile, assertSource);
  compileGeneratedSdk(output, [assertFile], { strict: true });
  const load = async (file: string) => requireRecord(await import(pathToFileURL(path.join(output, 'dist', file)).href), file);
  const Client = (await load('client.js'))[`${name}Client`];
  assert.equal(isGeneratedClientClass(Client), true);
  if (!isGeneratedClientClass(Client)) throw new TypeError(`${name}Client`);
  return { Client, load };
}

/** The URL of the one request that `send` makes when it gets options whose fetch records it. */
async function requestUrl(send: (fetchOptions: Record<string, unknown>) => Promise<unknown>): Promise<string> {
  const seen: CapturedRequest[] = [];
  await send({
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(captureRequest(url, init));
      return new Response(null, { status: 204 });
    },
  });
  return seen[0]?.url ?? '';
}

/** The URL of the request that `operation` sends when the client gets `options`. */
function callUrl(Client: GeneratedClientClass, options: Record<string, unknown>, operation: string): Promise<string> {
  return requestUrl((fetchOptions) => new Client({ ...options, ...fetchOptions })[operation]!().execute());
}

type OperationFactory = (options: Record<string, unknown>) => { execute: () => Promise<unknown> };

const TWO_SERVER_TYPES = `import type { ServersClientOptions } from './client.js';
const byIndex: ServersClientOptions = { server: 1 };
const byName: ServersClientOptions = { server: 'prod', serverVariables: { region: 'us' } };
const byBaseUrl: ServersClientOptions = { baseUrl: 'https://own.example' };
void [byIndex, byName, byBaseUrl];
`;

test('a client takes a document server by index, name or description, with variables filled', async (t) => {
  // protects: T-388 a generated client picks the servers URL of the document
  const { Client } = await loadSdk(t, twoServerDocument(), 'Servers', TWO_SERVER_TYPES);
  assert.equal(await callUrl(Client, {}, 'ping'), 'https://eu.api.example/v1/ping');
  assert.equal(await callUrl(Client, { server: 1 }, 'ping'), 'https://staging.example/v2/ping');
  assert.equal(await callUrl(Client, { server: 'Production' }, 'ping'), 'https://eu.api.example/v1/ping');
  assert.equal(await callUrl(Client, { server: 'Staging' }, 'ping'), 'https://named.example/ping', 'a name wins over a description');
  assert.equal(await callUrl(Client, { server: 'prod' }, 'ping'), 'https://eu.api.example/v1/ping');
  assert.equal(await callUrl(Client, { server: 2 }, 'ping'), 'https://decoy.example/ping');
  assert.equal(await callUrl(Client, { server: 'prod', serverVariables: { region: 'us', base: 'v9' } }, 'ping'), 'https://us.api.example/v9/ping');
  assert.equal(await callUrl(Client, { server: 1, baseUrl: 'https://own.example/' }, 'ping'), 'https://own.example/ping');
});

test('a client refuses a server variable outside its enum and a server the document lacks', async (t) => {
  // protects: T-388 a bad server choice fails when the client is created
  const { Client } = await loadSdk(t, twoServerDocument(), 'Servers', TWO_SERVER_TYPES);
  assert.throws(() => new Client({ serverVariables: { region: 'asia' } }), /server variable "region" must be one of eu, us; got "asia"/);
  assert.throws(() => new Client({ server: 4 }), /ServersClient found no server 4 in the document; it lists 4/);
  assert.throws(() => new Client({ serverVariables: { zone: 'x' } }), /server 0 declares no variable "zone"/);
  assert.throws(() => new Client({ server: 1, serverVariables: { region: 'eu' } }), /server 1 declares no variable "region"/);
  assert.throws(() => new Client({ serverVariables: { toString: 'x' } }), /declares no variable "toString"/);
  assert.throws(() => new Client({ server: 'Missing' }), /found no server "Missing"/);
});

test('generation stops for a server variable whose default is not a string', async (t) => {
  // protects: T-388 a server variable default must be a string
  const output = path.join(createFixtureProject(t, 'golem-openapi-servers-'), 'sdk');
  const document = { openapi: '3.2.0', info: { title: 'Bad', version: '1' }, servers: [{ url: 'https://{a}.example', variables: { a: { default: 5 } } }], paths: { '/ping': ping } };
  await assert.rejects(generateMaterializedSdk(document, { output, name: 'Bad' }), /OpenAPI validation failed with 1 error\(s\)[\s\S]*servers\/0\/variables\/a\/default/);
});

test('an operation module takes the same server options as the client', async (t) => {
  // protects: T-388 the standalone operation factory resolves document servers
  const { load } = await loadSdk(t, twoServerDocument(), 'Servers', TWO_SERVER_TYPES);
  const { ping: pingOperation } = await load('operations/ping.js');
  assert.equal(typeof pingOperation, 'function');
  assert.equal(await requestUrl((fetchOptions) => (pingOperation as OperationFactory)({ server: 1, ...fetchOptions }).execute()), 'https://staging.example/v2/ping');
});

test('a document with no servers keeps baseUrl required and offers no server option', async (t) => {
  // protects: T-388 baseUrl stays required when the document lists no servers
  const types = `import type { PlainClientOptions } from './client.js';
const options: PlainClientOptions = { baseUrl: 'https://own.example' };
// @ts-expect-error the document lists no servers, so baseUrl is required
const missing: PlainClientOptions = {};
// @ts-expect-error the document lists no servers to choose from
const chosen: PlainClientOptions = { baseUrl: 'https://own.example', server: 0 };
void [options, missing, chosen];
`;
  const { Client } = await loadSdk(t, { openapi: '3.1.0', info: { title: 'Plain', version: '1' }, paths: { '/ping': ping } }, 'Plain', types);
  assert.equal(await callUrl(Client, { baseUrl: 'https://own.example' }, 'ping'), 'https://own.example/ping');
  assert.throws(() => new Client({}), /PlainClient requires a non-empty baseUrl/);
});

const op = (operationId: string, extra: Record<string, unknown> = {}) => ({ operationId, responses: { 204: { description: 'ok' } }, ...extra });
const hostOf = (url: string, variables?: Record<string, unknown>) => ({ url, ...(variables ? { variables } : {}) });

/** Root servers, a path-level override, an operation-level override, and a path list equal to the root list. */
function overrideDocument(): unknown {
  const root = [{ url: 'https://prod.example', name: 'production' }, { url: 'https://staging.example', name: 'staging' }];
  return {
    openapi: '3.2.0',
    info: { title: 'Overrides', version: '1' },
    servers: root,
    paths: {
      '/ping': { get: op('ping') },
      '/same': { servers: root, get: op('same') },
      '/files': {
        servers: [hostOf('https://files-a.example/'), hostOf('https://files-b.example')],
        get: op('listFiles'),
        delete: op('removeFiles'),
        post: op('uploadFile', { servers: [hostOf('https://{bucket}.upload.example/{base}', { bucket: { default: 'b1' }, base: { default: 'v1' } })] }),
        put: op('replaceFile', { servers: [] }),
      },
    },
  };
}

const OVERRIDE_TYPES = `import type { OverridesClientOptions } from './client.js';
const options: OverridesClientOptions = { server: 'staging', baseUrl: 'https://own.example' };
void options;
`;

test('an operation goes to the servers its operation, path item or document assigns it', async (t) => {
  // protects: T-458 operation and path servers override the document servers
  const { Client, load } = await loadSdk(t, overrideDocument(), 'Overrides', OVERRIDE_TYPES);
  const chosen = { server: 1 };
  assert.equal(await callUrl(Client, chosen, 'ping'), 'https://staging.example/ping', 'a root operation follows the choice');
  assert.equal(await callUrl(Client, chosen, 'same'), 'https://staging.example/same', 'a path list equal to the root list is the root list');
  assert.equal(await callUrl(Client, chosen, 'listFiles'), 'https://files-a.example/files', 'a path override uses its first server');
  assert.equal(await callUrl(Client, { server: 'staging' }, 'removeFiles'), 'https://files-a.example/files');
  assert.equal(await callUrl(Client, chosen, 'uploadFile'), 'https://b1.upload.example/v1/files', 'an operation override beats the path override, with variable defaults');
  assert.equal(await callUrl(Client, chosen, 'replaceFile'), 'https://files-a.example/files', 'an empty servers list falls through to the path item');
  assert.equal(await callUrl(Client, {}, 'ping'), 'https://prod.example/ping');
  assert.equal(await callUrl(Client, {}, 'listFiles'), 'https://files-a.example/files');
  const { operationServers } = requireRecord(await load('servers.js'), 'servers.js');
  assert.deepEqual(operationServers, [
    { url: 'https://files-a.example/' },
    { url: 'https://{bucket}.upload.example/{base}', variables: { bucket: { default: 'b1' }, base: { default: 'v1' } } },
  ], 'the first server of each override list is held once');
});

test('baseUrl wins over document and override servers', async (t) => {
  // protects: T-458 an explicit baseUrl redirects every operation
  const { Client } = await loadSdk(t, overrideDocument(), 'Overrides', OVERRIDE_TYPES);
  const own = { baseUrl: 'https://own.example', server: 1 };
  assert.equal(await callUrl(Client, own, 'ping'), 'https://own.example/ping');
  assert.equal(await callUrl(Client, own, 'listFiles'), 'https://own.example/files');
  assert.equal(await callUrl(Client, own, 'uploadFile'), 'https://own.example/files');
});

test('an operation module uses its override server too', async (t) => {
  // protects: T-458 the standalone operation factory honors operation servers
  const { load } = await loadSdk(t, overrideDocument(), 'Overrides', OVERRIDE_TYPES);
  const { uploadFile } = await load('operations/uploadFile.js');
  assert.equal(await requestUrl((fetchOptions) => (uploadFile as OperationFactory)({ server: 1, ...fetchOptions }).execute()), 'https://b1.upload.example/v1/files');
});

test('a document with no root servers keeps baseUrl for every operation, whatever path servers it lists', async (t) => {
  // protects: T-458 no root servers: baseUrl is required and wins
  const document = { openapi: '3.1.0', info: { title: 'Overrides', version: '1' }, paths: { '/files': { servers: [hostOf('https://files.example')], get: op('listFiles') } } };
  const { Client } = await loadSdk(t, document, 'Overrides', `import type { OverridesClientOptions } from './client.js';
const options: OverridesClientOptions = { baseUrl: 'https://own.example' };
void options;
`);
  assert.equal(await callUrl(Client, { baseUrl: 'https://own.example' }, 'listFiles'), 'https://own.example/files');
});
