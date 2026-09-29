import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import { ClientRuntime, isUndeclaredResponseError, type RuntimeResponseContract } from '@exprtlabs/codegen/client';
import type { RuntimeValidationEngine } from '@exprtlabs/codegen/validation';

// The emitted runtime has no `validate` option: validation is off when the caller passes no operation validators.
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

const stubEngine = (): RuntimeValidationEngine => ({ addSchema: () => undefined, getSchema: () => undefined });

test('a default engine factory supplies one engine shared by runtimes built with it', () => {
  let created = 0;
  const createValidationEngine = () => { created += 1; return stubEngine(); };
  const first = new ClientRuntime('Tasks', { baseUrl: 'https://api.test' }, { createValidationEngine });
  const second = new ClientRuntime('Payments', { baseUrl: 'https://api.test' }, { createValidationEngine });
  assert.ok(first.validationEngine);
  assert.equal(first.validationEngine, second.validationEngine);
  assert.equal(created, 1);
});

test('an engine in the options wins over the factory, and no factory means no engine', () => {
  const own = stubEngine();
  let created = 0;
  const withOwn = new ClientRuntime('Tasks', { baseUrl: 'https://api.test', validationEngine: own },
    { createValidationEngine: () => { created += 1; return stubEngine(); } });
  assert.equal(withOwn.validationEngine, own);
  assert.equal(created, 0);
  assert.equal(new ClientRuntime('Tasks', { baseUrl: 'https://api.test' }).validationEngine, undefined);
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
  const reject = Object.assign((): boolean => false, { errors: [] as readonly unknown[] });
  const validators = { input: reject, responses: new Map([['200:application/x-ndjson', reject]]) };
  const response = new Response('{"id":1}\n', { headers: { 'content-type': 'application/x-ndjson' } });
  const result = await runtime.readResponse<DecodedResponse<AsyncIterable<unknown>>>(
    'op', response, [streamContract('application/x-ndjson', 'ndjson')], validators);
  const error = await collect(result.body).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof LibError);
  assert.equal(error.kind, LibErrorKind.Validation);
  assert.equal(error.message, 'API data validation failed.');
});
