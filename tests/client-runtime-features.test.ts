import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClientRuntime,
  addQueryParameter,
  applySecurity,
  addCookieParameter,
  addCookieStyleParameter,
  encodeBody,
  serializeContentParameter,
  serializeHeaderSimple,
  serializePath,
} from '@exprtlabs/golem/internal/client-runtime';

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

test('a multipart body sends no part for an undefined or null field', async () => {
  // protects: bug a multipart field with undefined or null was sent as the text "undefined" or "null"
  const file = new Blob(['x'], { type: 'text/plain' });
  const encoded = encodeBody(runtime, 'upload', { file, note: undefined, tag: null, kept: 'a' }, 'multipart/form-data', {});
  const form = encoded.body as FormData;
  assert.deepEqual([...form.keys()], ['file', 'kept']);
  assert.equal(form.get('kept'), 'a');
});

test('a multipart JSON part that is null sends the JSON text null', async () => {
  // protects: review finding: the fix above also dropped a null JSON part, which a server reads as absent
  const encoded = encodeBody(runtime, 'upload', { meta: null }, 'multipart/form-data', { 'multipart/form-data': { encoding: { meta: { contentType: 'application/json' } }, prefixEncoding: [], itemEncoding: null } });
  const part = (encoded.body as FormData).get('meta') as Blob;
  assert.equal(part.type, 'application/json');
  assert.equal(await part.text(), 'null');
});

test('a multipart JSON part sends every value as JSON text, a text part sends the string itself', async () => {
  // protects: T-852 a string in a multipart JSON part was sent as abc, not as the JSON text "abc"
  const metadata = { 'multipart/form-data': { encoding: { meta: { contentType: 'application/json' }, vendor: { contentType: 'application/vnd.api+json; charset=utf-8' }, lines: { contentType: 'application/x-ndjson' }, note: { contentType: 'text/plain' } }, prefixEncoding: [], itemEncoding: null } };
  const encoded = encodeBody(runtime, 'upload', { meta: ['abc', 7], vendor: 'abc', lines: 'abc', note: 'abc' }, 'multipart/form-data', metadata);
  const form = encoded.body as FormData;
  assert.deepEqual(await Promise.all(form.getAll('meta').map((part) => (part as Blob).text())), ['"abc"', '7']);
  assert.equal(await (form.get('vendor') as Blob).text(), '"abc"');
  assert.equal(await (form.get('lines') as Blob).text(), 'abc');
  assert.equal(await (form.get('note') as Blob).text(), 'abc');
  const nullLines = encodeBody(runtime, 'upload', { lines: null }, 'multipart/form-data', metadata).body as FormData;
  assert.deepEqual([...nullLines.keys()], []);
});

test('an empty array in the query adds no entry in any style, as an empty object adds none', () => {
  // protects: T-874 a non-exploded empty array was sent as an empty parameter
  const query: string[] = [];
  addQueryParameter(runtime, query, 'a', [], 'form', true, false);
  addQueryParameter(runtime, query, 'b', [], 'form', false, false);
  addQueryParameter(runtime, query, 'c', [], 'spaceDelimited', false, false);
  addQueryParameter(runtime, query, 'd', [], 'pipeDelimited', false, false);
  assert.deepEqual(query, []);
});

test('an empty-object query parameter adds no entry and a non-primitive one is a TypeError naming the parameter', () => {
  // protects: bug a query or path parameter that was an empty object or a Date became "[object Object]" or a locale string
  const query: string[] = [];
  addQueryParameter(runtime, query, 'filter', {}, 'form', true, false);
  addQueryParameter(runtime, query, 'filter', {}, 'form', false, false);
  assert.deepEqual(query, []);
  assert.throws(
    () => addQueryParameter(runtime, query, 'since', new Date(0), 'form', true, false),
    (error: unknown) => error instanceof TypeError && /"since"/.test(error.message),
  );
  assert.throws(
    () => serializePath(runtime, 'id', new Date(0), 'simple', false),
    (error: unknown) => error instanceof TypeError && /"id"/.test(error.message),
  );
  assert.throws(
    () => serializePath(runtime, 'id', {}, 'simple', false),
    (error: unknown) => error instanceof TypeError && /"id"/.test(error.message),
  );
  assert.deepEqual(query, []);
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

const rejectsNaming = (name: string) => (error: unknown) => error instanceof TypeError && error.message.includes(`"${name}"`);

test('a path value that resolves as a dot-segment or empty segment is a TypeError naming the parameter', () => {
  // protects: bug id ".." or "." was sent as a dot-segment that fetch resolves to the parent or the list route, and "" hit the list route
  for (const [value, style] of [['..', 'simple'], ['.', 'simple'], ['', 'simple'], ['', 'label'], ['.', 'label'], [[], 'simple']] as const) {
    assert.throws(() => serializePath(runtime, 'id', value, style, false), rejectsNaming('id'), `${JSON.stringify(value)} ${style}`);
  }
  assert.equal(serializePath(runtime, 'id', '..', 'matrix', false), ';id=..');
  assert.equal(serializePath(runtime, 'id', '...', 'simple', false), '...');
  assert.equal(serializePath(runtime, 'id', ['a', '..'], 'simple', false), 'a,..');
});

test('an object or array nested in an array or object parameter is a TypeError naming the parameter', () => {
  // protects: bug a nested object was sent as "[object Object]" (filter=%5Bobject%20Object%5D)
  const nested = [{ field: 'a' }];
  const query: string[] = [];
  for (const [style, explode] of [['form', false], ['form', true], ['spaceDelimited', false], ['pipeDelimited', false]] as const) {
    assert.throws(() => addQueryParameter(runtime, query, 'filter', nested, style, explode, false), rejectsNaming('filter'), `${style} ${explode}`);
    assert.throws(() => addQueryParameter(runtime, query, 'filter', { a: nested }, style, explode, false), rejectsNaming('filter'), `object ${style} ${explode}`);
  }
  assert.throws(() => addQueryParameter(runtime, query, 'filter', { a: [1, 2] }, 'deepObject', true, false), rejectsNaming('filter'));
  assert.deepEqual(query, []);
  addQueryParameter(runtime, query, 'filter', { a: { b: 1, c: 'x y' } }, 'deepObject', true, false);
  assert.deepEqual(query, ['filter[a][b]=1', 'filter[a][c]=x%20y']);
  for (const style of ['simple', 'label', 'matrix']) {
    assert.throws(() => serializePath(runtime, 'id', nested, style, false), rejectsNaming('id'), `array ${style}`);
    assert.throws(() => serializePath(runtime, 'id', { a: nested }, style, true), rejectsNaming('id'), `object ${style}`);
  }
  assert.throws(() => serializeHeaderSimple(runtime, nested, false, 'X-Filter'), rejectsNaming('X-Filter'));
  assert.throws(() => serializeHeaderSimple(runtime, { a: nested }, true, 'X-Filter'), rejectsNaming('X-Filter'));
  assert.throws(() => serializeHeaderSimple(runtime, new Date(0), false, 'X-Since'), rejectsNaming('X-Since'));
  assert.equal(serializeHeaderSimple(runtime, ['a', 1], false, 'X-Ids'), 'a,1');
  for (const add of [addCookieParameter, addCookieStyleParameter]) {
    assert.throws(() => add(runtime, [], 'tags', nested, false), rejectsNaming('tags'));
    assert.throws(() => add(runtime, [], 'tags', { a: nested }, true), rejectsNaming('tags'));
  }
  const form = { operation: 'listTasks', name: 'filter', in: 'querystring', contentType: 'application/x-www-form-urlencoded' } as const;
  assert.throws(() => serializeContentParameter(runtime, { a: nested }, form), rejectsNaming('filter'));
});

test('a cookie-style parameter holding ";" or a control character is a TypeError, not a second cookie', () => {
  // protects: bug session "a; admin=1" was sent as "session=a; admin=1", which sets a second cookie
  for (const value of ['a; admin=1', 'a\r\nX-Evil: 1', 'a\tb', 'a\u007f']) {
    assert.throws(() => addCookieStyleParameter(runtime, [], 'session', value, false), rejectsNaming('session'), JSON.stringify(value));
  }
  assert.throws(() => addCookieStyleParameter(runtime, [], 'ids', ['ok', 'a;b'], true), rejectsNaming('ids'));
  assert.throws(() => addCookieStyleParameter(runtime, [], 'ids', { 'k;': 'v' }, true), rejectsNaming('ids'));
  const cookies: string[] = [];
  addCookieStyleParameter(runtime, cookies, 'session', 'a b=c', false);
  assert.deepEqual(cookies, ['session=a b=c']);
});
