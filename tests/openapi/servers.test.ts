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

/** The URL of the request that `ping` sends when the client gets `options`. */
async function pingUrl(Client: GeneratedClientClass, options: Record<string, unknown>): Promise<string> {
  const seen: CapturedRequest[] = [];
  const client = new Client({
    ...options,
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(captureRequest(url, init));
      return new Response(null, { status: 204 });
    },
  });
  await client['ping']!().execute();
  return seen[0]?.url ?? '';
}

const TWO_SERVER_TYPES = `import type { ServersClientOptions } from './client.js';
const byIndex: ServersClientOptions = { server: 1 };
const byName: ServersClientOptions = { server: 'prod', serverVariables: { region: 'us' } };
const byBaseUrl: ServersClientOptions = { baseUrl: 'https://own.example' };
void [byIndex, byName, byBaseUrl];
`;

test('a client takes a document server by index, name or description, with variables filled', async (t) => {
  // protects: T-388 a generated client picks the servers URL of the document
  const { Client } = await loadSdk(t, twoServerDocument(), 'Servers', TWO_SERVER_TYPES);
  assert.equal(await pingUrl(Client, {}), 'https://eu.api.example/v1/ping');
  assert.equal(await pingUrl(Client, { server: 1 }), 'https://staging.example/v2/ping');
  assert.equal(await pingUrl(Client, { server: 'Staging' }), 'https://staging.example/v2/ping');
  assert.equal(await pingUrl(Client, { server: 'prod', serverVariables: { region: 'us', base: 'v9' } }), 'https://us.api.example/v9/ping');
  assert.equal(await pingUrl(Client, { server: 1, baseUrl: 'https://own.example/' }), 'https://own.example/ping');
});

test('a client refuses a server variable outside its enum and a server the document lacks', async (t) => {
  // protects: T-388 a bad server choice fails when the client is created
  const { Client } = await loadSdk(t, twoServerDocument(), 'Servers', TWO_SERVER_TYPES);
  assert.throws(() => new Client({ serverVariables: { region: 'asia' } }), /server variable "region" must be one of eu, us; got "asia"/);
  assert.throws(() => new Client({ server: 2 }), /ServersClient found no server 2 in the document; it lists 2/);
  assert.throws(() => new Client({ server: 'Missing' }), /found no server "Missing"/);
});

test('an operation module takes the same server options as the client', async (t) => {
  // protects: T-388 the standalone operation factory resolves document servers
  const { load } = await loadSdk(t, twoServerDocument(), 'Servers', TWO_SERVER_TYPES);
  const { ping: pingOperation } = await load('operations/ping.js');
  assert.equal(typeof pingOperation, 'function');
  const seen: CapturedRequest[] = [];
  const operation = (pingOperation as (options: Record<string, unknown>) => { execute: () => Promise<unknown> })({
    server: 'Staging',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(captureRequest(url, init));
      return new Response(null, { status: 204 });
    },
  });
  await operation.execute();
  assert.equal(seen[0]?.url, 'https://staging.example/v2/ping');
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
  assert.equal(await pingUrl(Client, { baseUrl: 'https://own.example' }), 'https://own.example/ping');
  assert.throws(() => new Client({}), /PlainClient requires a non-empty baseUrl/);
});
