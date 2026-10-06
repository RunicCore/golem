import type { TestContext } from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { generate } from '#openapi/generator';
import {
  captureRequest,
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
  writeOpenApiDocument,
} from './helpers.js';

async function loadClient(t: TestContext, document: unknown, name: string) {
  const output = path.join(createFixtureProject(t, 'golem-openapi-headers-'), 'sdk');
  await generateMaterializedSdk(document, {
    output,
    name,
    profile: { mobx: false, validation: false },
  });
  compileGeneratedSdk(output);
  const module = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    `${name} client`,
  );
  const Client = module[`${name}Client`];
  assert.equal(isGeneratedClientClass(Client), true);
  if (!isGeneratedClientClass(Client)) throw new TypeError(`${name}Client`);
  return Client;
}

test('API execution resolves Basic and cookie credentials and merges constructor headers', async (t) => {
  const responses = { 204: { description: 'Accepted' } };
  const Client = await loadClient(t, {
    openapi: '3.1.0', info: { title: 'Authentication', version: '1' },
    components: { securitySchemes: {
      basic: { type: 'http', scheme: 'basic' },
      session: { type: 'apiKey', in: 'cookie', name: 'session' },
    } },
    paths: {
      '/basic': { get: { operationId: 'basic', security: [{ basic: [] }], responses,
        parameters: [{ name: 'X-Mode', in: 'header', schema: { type: 'string' } }],
      } },
      '/session': { get: { operationId: 'session', security: [{ session: [] }], responses } },
    },
  }, 'Authentication');
  const requests: Headers[] = [];
  let user = 'reader';
  let authCalls = 0;
  const client = new Client({
    baseUrl: 'https://api.example',
    headers: { 'X-Shared': 'shared', 'X-Mode': 'default' },
    auth: {
      basic: () => { authCalls++; return { username: user, password: 'p:a ss' }; },
      session: 'a b/c',
    },
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(new Headers(init?.headers));
      return new Response(null, { status: 204 });
    },
  });
  const api = client.basic();
  assert.equal(authCalls, 0, 'factory does not resolve credentials');
  assert.equal(requests.length, 0);
  await api.execute({ header: { 'X-Mode': 'operation' } });
  user = 'editor';
  await api.execute({});
  await client.session().execute({});
  assert.equal(authCalls, 2);
  assert.equal(requests[0].get('authorization'), `Basic ${btoa('reader:p:a ss')}`);
  assert.equal(requests[1].get('authorization'), `Basic ${btoa('editor:p:a ss')}`);
  assert.equal(requests[0].get('X-Shared'), 'shared');
  assert.equal(requests[0].get('X-Mode'), 'operation');
  assert.equal(requests[1].get('X-Mode'), 'default', 'one execution cannot mutate shared headers');
  assert.equal(requests[2].get('cookie'), 'session=a%20b%2Fc');
});

test('header simple values stay literal and never percent-decode, and OAS 3.2 style cookie stringifies without URI encoding while form cookies keep encoding', async (t) => {
  const Client = await loadClient(t, {
    openapi: '3.2.0',
    info: { title: 'HeadersCookies', version: '1' },
    paths: {
      '/echo': {
        get: {
          operationId: 'echo',
          parameters: [
            { name: 'X-Greeting', in: 'header', schema: { type: 'string' } },
            { name: 'X-Percent', in: 'header', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'ok',
              headers: {
                'X-Greeting': { schema: { type: 'string' } },
                'X-Percent': { schema: { type: 'string' } },
              },
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/jar': {
        get: {
          operationId: 'readJar',
          parameters: [
            {
              name: 'plain',
              in: 'cookie',
              style: 'cookie',
              schema: { type: 'string' },
            },
            {
              name: 'tags',
              in: 'cookie',
              style: 'cookie',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'legacy',
              in: 'cookie',
              style: 'form',
              schema: { type: 'string' },
            },
          ],
          responses: { 204: { description: 'ok' } },
        },
      },
    },
  }, 'HeadersCookies');

  const headerClient = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const captured = captureRequest(url, init);
      assert.equal(captured.init.headers.get('X-Greeting'), 'hello world');
      assert.equal(captured.init.headers.get('X-Percent'), 'a%20b');
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'X-Greeting': 'hello world',
          'X-Percent': 'a%20b',
        },
      });
    },
  });
  const result = await headerClient.echo().execute({
    header: { 'X-Greeting': 'hello world', 'X-Percent': 'a%20b' },
  });
  assert.equal(result.headers?.['X-Greeting'], 'hello world');
  assert.equal(result.headers?.['X-Percent'], 'a%20b');

  let cookie: string | null = null;
  const cookieClient = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      cookie = captureRequest(url, init).init.headers.get('cookie');
      return new Response(null, { status: 204 });
    },
  });
  await cookieClient.readJar().execute({
    cookie: {
      plain: 'hello world',
      tags: ['a b', 'c%20d'],
      legacy: 'hello world',
    },
  });
  assert.equal(
    cookie,
    'plain=hello world; tags=a b,c%20d; legacy=hello%20world',
  );
});

test('style cookie is accepted for a cookie parameter and rejected for a header parameter', async (t) => {
  const directory = createFixtureProject(t, 'golem-openapi-cookie-style-');
  const valid = writeOpenApiDocument(directory, {
    openapi: '3.2.0',
    info: { title: 'ValidCookie', version: '1' },
    paths: {
      '/ok': {
        get: {
          operationId: 'ok',
          parameters: [
            { name: 'session', in: 'cookie', style: 'cookie', schema: { type: 'string' } },
          ],
          responses: { 204: { description: 'ok' } },
        },
      },
    },
  });
  await generate({
    input: valid,
    output: path.join(directory, 'sdk'),
    profile: { mobx: false, validation: false },
  });

  await assert.rejects(
    () => generate({
      input: writeOpenApiDocument(directory, {
        openapi: '3.2.0',
        info: { title: 'HeaderCookie', version: '1' },
        paths: {
          '/bad': {
            get: {
              operationId: 'bad',
              parameters: [
                { name: 'X-Session', in: 'header', style: 'cookie', schema: { type: 'string' } },
              ],
              responses: { 204: { description: 'ok' } },
            },
          },
        },
      }, 'header.json'),
      output: path.join(directory, 'sdk-header'),
      profile: { mobx: false, validation: false },
    }),
    /^Error: OpenAPI validation failed with 1 error\(s\):\nstruct: Must be "simple" \(header\.json#\/paths\/~1bad\/get\/parameters\/0\/style\)$/,
  );
});
