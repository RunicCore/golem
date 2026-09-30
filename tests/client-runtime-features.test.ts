import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClientRuntime,
  addQueryParameter,
  applySecurity,
  encodeBody,
  serializeContentParameter,
  serializePath,
} from '@exprtlabs/golem/client';

const runtime = new ClientRuntime('Tasks', { baseUrl: 'https://api.test' });
const context = { operation: 'listTasks', name: 'filter', in: 'query', contentType: 'application/x-custom' } as const;

test('simple path values are percent-encoded', () => {
  assert.equal(serializePath(runtime, 'id', 'a b/c', 'simple', false), 'a%20b%2Fc');
});

test('label and matrix path styles prefix the encoded value', () => {
  assert.equal(serializePath(runtime, 'id', ['a', 'b'], 'label', true), '.a.b');
  assert.equal(serializePath(runtime, 'id', ['a', 'b'], 'matrix', true), ';id=a;id=b');
  assert.throws(() => serializePath(runtime, 'id', 'a', 'form', false), /Unsupported path parameter style: form/);
});

test('form-exploded arrays repeat the query name', () => {
  const query: string[] = [];
  addQueryParameter(runtime, query, 'status', ['paid', 'pending'], 'form', true, false);
  assert.deepEqual(query, ['status=paid', 'status=pending']);
});

test('allowReserved keeps reserved characters and passes escapes through', () => {
  const query: string[] = [];
  addQueryParameter(runtime, query, 'q', 'a/b?%41', 'form', true, true);
  assert.deepEqual(query, ['q=a/b?%41']);
});

test('deepObject query parameters nest keys in brackets', () => {
  const query: string[] = [];
  addQueryParameter(runtime, query, 'filter', { a: { b: 1 } }, 'deepObject', true, false);
  assert.deepEqual(query, ['filter[a][b]=1']);
});

test('nested deepObject values serialize recursively and skip null', () => {
  const query: string[] = [];
  addQueryParameter(
    runtime, query, 'filter',
    { owner: { name: 'Ann', nick: null, team: { id: 7 } }, kind: 'x' },
    'deepObject', true, false,
  );
  assert.deepEqual(query, ['filter[owner][name]=Ann', 'filter[owner][team][id]=7', 'filter[kind]=x']);
});

test('a custom parameter serializer replaces the default for its media type', () => {
  const custom = new ClientRuntime('Tasks', {
    baseUrl: 'https://api.test',
    parameterSerializers: { 'application/x-custom': () => 'X' },
  });
  assert.equal(serializeContentParameter(custom, { a: 1 }, context), 'X');
  assert.throws(() => serializeContentParameter(runtime, { a: 1 }, context), /No parameter serializer configured/);
});

test('a form body encodes to urlencoded fields', async () => {
  const encoded = encodeBody(runtime, 'createTask', { a: 1, b: 2 }, 'application/x-www-form-urlencoded', {});
  assert.deepEqual(encoded, { body: 'a=1&b=2', contentType: 'application/x-www-form-urlencoded' });
});

test('a custom body encoder replaces the built-in JSON encoding', () => {
  const custom = new ClientRuntime('Tasks', {
    baseUrl: 'https://api.test',
    bodyEncoders: { 'application/json': () => 'custom' },
  });
  assert.deepEqual(encodeBody(custom, 'createTask', { a: 1 }, 'application/json', {}), {
    body: 'custom',
    contentType: 'application/json',
  });
  assert.deepEqual(encodeBody(runtime, 'createTask', { a: 1 }, 'application/json', {}), {
    body: '{"a":1}',
    contentType: 'application/json',
  });
});

test('an apiKey header scheme sets the configured header', async () => {
  const keyed = new ClientRuntime('Tasks', { baseUrl: 'https://api.test', auth: { key: 'k' } });
  const headers = new Headers();
  await applySecurity(keyed, [{ key: [] }], [], headers, [], { key: { type: 'apiKey', in: 'header', name: 'X-Key' } });
  assert.equal(headers.get('X-Key'), 'k');
});

test('missing credentials fail unless an empty requirement makes auth optional', async () => {
  const schemes = { key: { type: 'apiKey', in: 'header', name: 'X-Key' } };
  await assert.rejects(
    applySecurity(runtime, [{ key: [] }], [], new Headers(), [], schemes),
    /No configured credentials satisfy/,
  );
  await applySecurity(runtime, [{ key: [] }, {}], [], new Headers(), [], schemes);
});

test('an optional requirement is a fallback: configured credentials are still sent', async () => {
  const schemes = { bearer: { type: 'http', scheme: 'bearer' } };
  const requirements: Array<Record<string, string[]>> = [{}, { bearer: [] }];
  const withToken = new ClientRuntime('Tasks', { baseUrl: 'https://api.test', auth: { bearer: 'token' } });
  const sent = new Headers();
  await applySecurity(withToken, requirements, [], sent, [], schemes);
  assert.equal(sent.get('authorization'), 'Bearer token');
  const anonymous = new Headers();
  await applySecurity(runtime, requirements, [], anonymous, [], schemes);
  assert.equal(anonymous.get('authorization'), null);
});

test('basic credentials are UTF-8 encoded before base64 and the user-id cannot contain a colon', async () => {
  const schemes = { basic: { type: 'http', scheme: 'basic' } };
  const basic = (username: string, password: string) =>
    new ClientRuntime('Tasks', { baseUrl: 'https://api.test', auth: { basic: { username, password } } });
  const headers = new Headers();
  await applySecurity(basic('jürgen', 'π'), [{ basic: [] }], [], headers, [], schemes);
  assert.equal(headers.get('authorization'), `Basic ${Buffer.from('jürgen:π', 'utf8').toString('base64')}`);
  // RFC 7617: the user-id cannot contain a colon.
  await assert.rejects(
    applySecurity(basic('a:b', 'p'), [{ basic: [] }], [], new Headers(), [], schemes),
    /must not contain ":"/,
  );
});
