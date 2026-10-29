import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { RuntimeResponseContract } from '@exprtlabs/golem/client';
import { ClientRuntime, isUndeclaredResponseError } from '@exprtlabs/golem/internal/client-runtime';
import { responseCheck } from '@exprtlabs/golem/internal/client-validation-runtime';
import type { SchemaIssue } from '@exprtlabs/golem/validation';

// The emitted runtime has no `validate` option: validation is off when the caller passes no response check.
const NO_VALIDATORS = undefined;

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const jsonContract: RuntimeResponseContract = {
  status: '200',
  content: [{ contentType: 'application/json', framing: 'body' }],
  headers: [],
};

interface DecodedResponse<Body> {
  matched: 'status' | 'range' | 'default';
  status: number;
  contentType: string | null;
  body: Body;
  headers: Record<string, unknown>;
}

test('a declared status and media type returns status and decoded body', async () => {
  const runtime = new ClientRuntime('Tasks', { baseUrl: 'https://api.test' });
  const result = await runtime.readResponse<DecodedResponse<unknown>>(
    'getTask', json(200, { id: '1' }), [jsonContract], NO_VALIDATORS);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: '1' });
});

test('an undeclared status throws an error that only its own client recognises', async () => {
  const runtime = new ClientRuntime('Tasks', { baseUrl: 'https://api.test' });
  const error = await runtime.readResponse('getTask', json(418, {}), [jsonContract], NO_VALIDATORS)
    .then(() => undefined, (caught: unknown) => caught);
  assert.equal(isUndeclaredResponseError(error, 'Tasks'), true);
  assert.equal(isUndeclaredResponseError(error, 'Payments'), false);
  assert.equal(isUndeclaredResponseError(error), true);
  assert.equal(isUndeclaredResponseError(new Error('x'), 'Tasks'), false);
});

test('an empty baseUrl names the client in the error', () => {
  assert.throws(() => new ClientRuntime('Tasks', { baseUrl: '' }), /TasksClient requires a non-empty baseUrl/);
});

test('url joins the base URL, path and query', () => {
  const runtime = new ClientRuntime('Tasks', { baseUrl: 'https://api.test/v1/' });
  assert.equal(runtime.url('/tasks', ['limit=2']), 'https://api.test/v1/tasks?limit=2');
});

test('an application/x-ndjson response declared as a stream yields one object per line', async () => {
  const runtime = new ClientRuntime('Tasks', { baseUrl: 'https://api.test' });
  const contract: RuntimeResponseContract = {
    status: '200',
    content: [{ contentType: 'application/x-ndjson', framing: 'ndjson' }],
    headers: [],
  };
  const response = new Response('{"id":1}\n{"id":2}\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
  const result = await runtime.readResponse<DecodedResponse<AsyncIterable<unknown>>>(
    'watchTasks', response, [contract], NO_VALIDATORS);
  const items: unknown[] = [];
  for await (const item of result.body) items.push(item);
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
});

test('a declared integer response header decodes to a number', async () => {
  const runtime = new ClientRuntime('Tasks', { baseUrl: 'https://api.test' });
  const contract: RuntimeResponseContract = {
    ...jsonContract,
    headers: [{
      name: 'x-total', style: 'simple', explode: false, contentType: null,
      kind: 'integer', itemKind: null, propertyKinds: {},
    }],
  };
  const response = new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-total': '42' },
  });
  const result = await runtime.readResponse<DecodedResponse<unknown>>('listTasks', response, [contract], NO_VALIDATORS);
  assert.deepEqual(result.headers, { 'x-total': 42 });
});

const runtime = new ClientRuntime('Tasks', { baseUrl: 'https://api.test' });
const empty = (status: number) => new Response(null, { status });
const noContent = (status: string): RuntimeResponseContract => ({ status, content: [], headers: [] });

test('an exact status beats a range, which beats default', async () => {
  const contracts = [noContent('default'), noContent('2XX'), noContent('200')];
  const read = async (status: number) =>
    (await runtime.readResponse<DecodedResponse<unknown>>('op', empty(status), contracts, NO_VALIDATORS)).matched;
  assert.equal(await read(200), 'status');
  assert.equal(await read(204), 'range');
  assert.equal(await read(404), 'default');
});

test('a 2XX range contract matches 204 and a default contract matches otherwise-undeclared statuses', async () => {
  const result = await runtime.readResponse<DecodedResponse<unknown>>('op', empty(204), [noContent('2XX')], NO_VALIDATORS);
  assert.equal(result.status, 204);
  assert.equal(result.body, undefined);
  const fallback = await runtime.readResponse<DecodedResponse<unknown>>('op', empty(500), [noContent('200'), noContent('default')], NO_VALIDATORS);
  assert.equal(fallback.matched, 'default');
});

test('an exact media type beats type/*, which beats */*', async () => {
  const media = (...types: string[]): RuntimeResponseContract => ({
    status: '200',
    content: types.map((contentType) => ({ contentType, framing: 'body' as const })),
    headers: [],
  });
  const read = async (contract: RuntimeResponseContract) =>
    (await runtime.readResponse<DecodedResponse<unknown>>('op', json(200, {}), [contract], NO_VALIDATORS)).contentType;
  assert.equal(await read(media('*/*', 'application/*', 'application/json')), 'application/json');
  assert.equal(await read(media('*/*', 'application/*')), 'application/*');
  assert.equal(await read(media('*/*')), '*/*');
});

test('a declared status with an undeclared media type throws the undeclared error', async () => {
  const error = await runtime.readResponse('op', json(200, {}, 'text/csv'), [jsonContract], NO_VALIDATORS)
    .then(() => undefined, (caught: unknown) => caught);
  assert.equal(isUndeclaredResponseError(error, 'Tasks'), true);
  if (!isUndeclaredResponseError(error)) throw new TypeError('undeclared response error');
  assert.equal(error.status, 200);
  assert.equal(error.contentType, 'text/csv');
});

// Response forbids a 204 body, so a stub reports 204 for a response that still carries one.
const unexpectedBody = (onCancel: () => void) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode('unexpected')); },
  cancel() { onCancel(); },
});

test('a declared response without content ignores and cancels a body the server sends anyway', async () => {
  let cancelled = false;
  const response = new Response(unexpectedBody(() => { cancelled = true; }), {
    status: 200, headers: { 'content-type': 'text/plain' },
  });
  Object.defineProperty(response, 'status', { value: 204 });
  const result = await runtime.readResponse<DecodedResponse<unknown>>('op', response, [noContent('204')], NO_VALIDATORS);
  assert.equal(result.status, 204);
  assert.equal(result.body, undefined);
  assert.equal(cancelled, true, 'the unread body is cancelled');
});

test('an undeclared status is a response error carrying its facts, and its body is cancelled', async () => {
  let cancelled = false;
  const response = new Response(unexpectedBody(() => { cancelled = true; }), {
    status: 200, headers: { 'content-type': 'text/plain' },
  });
  await assert.rejects(
    () => runtime.readResponse('emptyResponse', response, [noContent('204')], NO_VALIDATORS),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Response
      && isUndeclaredResponseError(error, 'Tasks')
      && Reflect.get(error, 'operation') === 'emptyResponse'
      && Reflect.get(error, 'status') === 200
      && Reflect.get(error, 'contentType') === 'text/plain'
      && Reflect.get(error, 'headers') instanceof Headers
      && Reflect.get(error, 'headers').get('content-type') === 'text/plain',
  );
  assert.equal(cancelled, true, 'the undeclared response body is cancelled');
  assert.equal(isUndeclaredResponseError(new LibError(LibErrorKind.Response, 'other')), false);
});

const streamContract = (contentType: string, framing: 'json-seq' | 'sse' | 'ndjson'): RuntimeResponseContract => ({
  status: '200', content: [{ contentType, framing }], headers: [],
});
const collect = async (body: AsyncIterable<unknown>): Promise<unknown[]> => {
  const items: unknown[] = [];
  for await (const item of body) items.push(item);
  return items;
};

test('a JSON-seq stream yields its records', async () => {
  const RS = '\u001e';
  const response = new Response(`${RS}{\n  "id": 1\n}\n${RS}${RS}{"id":2}\n`, {
    headers: { 'content-type': 'application/json-seq' },
  });
  const result = await runtime.readResponse<DecodedResponse<AsyncIterable<unknown>>>(
    'op', response, [streamContract('application/json-seq', 'json-seq')], NO_VALIDATORS);
  assert.deepEqual(await collect(result.body), [{ id: 1 }, { id: 2 }]);
});

test('an SSE stream yields its data payloads', async () => {
  const response = new Response('event: ping\ndata: {"id":1}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
  const result = await runtime.readResponse<DecodedResponse<AsyncIterable<unknown>>>(
    'op', response, [streamContract('text/event-stream', 'sse')], NO_VALIDATORS);
  assert.deepEqual(await collect(result.body), [{ data: '{"id":1}', event: 'ping' }]);
});

test('a stream item that fails validation raises the validation error', async () => {
  const reject = (): readonly SchemaIssue[] => [{ code: 'custom', path: [] }];
  const validators = { input: reject, responses: new Map([['200:application/x-ndjson', reject]]) };
  const response = new Response('{"id":1}\n', { headers: { 'content-type': 'application/x-ndjson' } });
  const result = await runtime.readResponse<DecodedResponse<AsyncIterable<unknown>>>(
    'op', response, [streamContract('application/x-ndjson', 'ndjson')], responseCheck(validators));
  const error = await collect(result.body).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof LibError);
  assert.equal(error.kind, LibErrorKind.Validation);
  assert.equal(error.message, 'API data validation failed.');
});

test('an array response header with an empty value decodes to an empty array', async () => {
  // protects: bug an empty array header X-Ids: threw "Invalid numeric response header" because "".split(",") has one item
  const runtime = new ClientRuntime('Tasks', { baseUrl: 'https://api.test' });
  const contract: RuntimeResponseContract = {
    ...jsonContract,
    headers: [{ name: 'x-ids', style: 'simple', explode: false, contentType: null, kind: 'array', itemKind: 'integer', propertyKinds: {} }],
  };
  const read = (value: string) => runtime.readResponse<DecodedResponse<unknown>>(
    'listTasks', new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'x-ids': value } }), [contract], NO_VALIDATORS);
  assert.deepEqual((await read('')).headers, { 'x-ids': [] });
  assert.deepEqual((await read('1, 2')).headers, { 'x-ids': [1, 2] });
  await assert.rejects(read('1,'), /Invalid numeric response header/);
});
