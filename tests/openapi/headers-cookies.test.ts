import type { TestContext } from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#openapi/generator';
import {
  captureRequest,
  compileGeneratedSdk,
  generateMaterializedSdk,
  loadGeneratedClient,
  writeOpenApiDocument,
} from './helpers.js';

async function loadClient(t: TestContext, document: unknown, name: string) {
  const output = path.join(createFixtureProject(t, 'golem-openapi-headers-'), 'sdk');
  await generateMaterializedSdk(document, {
    output,
    name,
    profile: { validation: false },
  });
  compileGeneratedSdk(output);
  return loadGeneratedClient(output, name);
}

function cookieSendingClient(Client: Awaited<ReturnType<typeof loadClient>>) {
  const sent: { cookie: string | null } = { cookie: null };
  const client = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      sent.cookie = captureRequest(url, init).init.headers.get('cookie');
      return new Response(null, { status: 204 });
    },
  });
  return { client, sent };
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

  const { client: cookieClient, sent } = cookieSendingClient(Client);
  await cookieClient.readJar().execute({
    cookie: {
      plain: 'hello world',
      tags: ['a b', 'c%20d'],
      legacy: 'hello world',
    },
  });
  assert.equal(
    sent.cookie,
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
    profile: { validation: false },
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
      profile: { validation: false },
    }),
    /^Error: OpenAPI validation failed with 1 error\(s\):\nstruct: Must be "simple" \(header\.json#\/paths\/~1bad\/get\/parameters\/0\/style\)$/,
  );
});

const numericHeaderDocument = {
  openapi: '3.1.0',
  info: { title: 'NumericHeaders', version: '1' },
  components: { schemas: { Count: { type: 'integer' } } },
  paths: {
    '/count': {
      get: {
        operationId: 'count',
        responses: {
          200: {
            description: 'ok',
            headers: {
              'X-Plain': { schema: { type: 'integer' } },
              'X-Float': { schema: { type: 'number' } },
              'X-AnyOf': { schema: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
              'X-OneOf': { schema: { oneOf: [{ type: 'integer' }, { type: 'null' }] } },
              'X-AllOf': { schema: { allOf: [{ $ref: '#/components/schemas/Count' }] } },
            },
          },
        },
      },
    },
  },
};

function clientReturning(Client: Awaited<ReturnType<typeof loadClient>>, headers: Record<string, string>) {
  return new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => new Response(null, { status: 200, headers }),
  });
}

test('an integer response header declared through anyOf, oneOf or a $ref decodes to a number', async (t) => {
  // protects: header typed number | null returned the raw string because the kind was read only from a direct type
  const Client = await loadClient(t, numericHeaderDocument, 'NumericHeaders');
  const result = await clientReturning(Client, {
    'X-Plain': '7', 'X-Float': '2.5', 'X-AnyOf': '8', 'X-OneOf': '9', 'X-AllOf': '10',
  }).count().execute({});
  assert.deepEqual(result.headers, { 'X-Plain': 7, 'X-Float': 2.5, 'X-AnyOf': 8, 'X-OneOf': 9, 'X-AllOf': 10 });
});

test('a numeric response header that is not a number of its declared kind is rejected', async (t) => {
  // protects: integer header '' decoded to 0 and '0x10', '1e3', '1.5' were accepted through Number()
  const Client = await loadClient(t, numericHeaderDocument, 'NumericHeaders');
  for (const [name, value] of [['X-Plain', ''], ['X-Plain', '0x10'], ['X-Plain', '1e3'], ['X-Plain', '1.5'], ['X-AnyOf', '1.5'], ['X-Float', ''], ['X-Float', '0x10']]) {
    await assert.rejects(
      () => clientReturning(Client, { [name]: value }).count().execute({}),
      new TypeError(`Invalid numeric response header: ${value}`),
      `${name}: ${JSON.stringify(value)}`,
    );
  }
  const accepted = await clientReturning(Client, { 'X-Float': '1e3', 'X-Plain': '-5' }).count().execute({});
  assert.deepEqual(accepted.headers, { 'X-Plain': -5, 'X-Float': 1000 });
});

test('a style cookie array or object with no explode is written exploded, as a form cookie is', async (t) => {
  // protects: suspected bug T-634 style cookie with no explode was written non-exploded; OAS 3.2 defaults explode to true for cookie
  const parameter = (name: string, style: string, schema: unknown) => ({ name, in: 'cookie', style, schema });
  const Client = await loadClient(t, {
    openapi: '3.2.0',
    info: { title: 'CookieExplode', version: '1' },
    paths: { '/jar': { get: {
      operationId: 'readJar',
      parameters: [
        parameter('tags', 'cookie', { type: 'array', items: { type: 'string' } }),
        parameter('point', 'cookie', { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } } }),
        parameter('formTags', 'form', { type: 'array', items: { type: 'string' } }),
      ],
      responses: { 204: { description: 'ok' } },
    } } },
  }, 'CookieExplode');
  const { client, sent } = cookieSendingClient(Client);
  await client.readJar().execute({ cookie: { tags: ['a', 'b'], point: { x: '1', y: '2' }, formTags: ['c', 'd'] } });
  assert.equal(sent.cookie, 'tags=a; tags=b; x=1; y=2; formTags=c; formTags=d');
});

test('an empty object response header decodes to an empty object, exploded or not', async (t) => {
  // protects: suspected bug T-635 an empty object header threw a TypeError; RFC 6570 section 2.3 makes an empty map undefined and simple expansion writes it as nothing
  const point = { type: 'object', properties: { x: { type: 'integer' } } };
  const Client = await loadClient(t, {
    openapi: '3.1.0',
    info: { title: 'EmptyObjectHeaders', version: '1' },
    paths: { '/point': { get: {
      operationId: 'point',
      responses: { 200: {
        description: 'ok',
        headers: {
          'X-Plain': { schema: point },
          'X-Exploded': { explode: true, schema: point },
        },
      } },
    } } },
  }, 'EmptyObjectHeaders');
  const empty = await clientReturning(Client, { 'X-Plain': '', 'X-Exploded': '' }).point().execute({});
  assert.deepEqual(empty.headers, { 'X-Plain': {}, 'X-Exploded': {} });
  const filled = await clientReturning(Client, { 'X-Plain': 'x,1', 'X-Exploded': 'x=2' }).point().execute({});
  assert.deepEqual(filled.headers, { 'X-Plain': { x: 1 }, 'X-Exploded': { x: 2 } });
});
