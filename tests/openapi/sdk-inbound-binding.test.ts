import assert from 'node:assert/strict';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { fileFixtureScope, onceShared } from '../fixture-project.js';
import { importGeneratedModule, requireRecord } from './helpers.js';
import { loadSdk } from './sdk-client-fixture.js';

// The SDK converts and checks the traffic of its webhooks and callbacks like its outbound traffic (R-80): the binding takes the app's port and returns one handler per inbound operation.

const DATE_TIME = { type: 'string', format: 'date-time' };
const EVENT = { $ref: '#/components/schemas/Event' };
const ACK = { $ref: '#/components/schemas/Ack' };
const ACK_RESPONSE = { description: 'Accepted', content: { 'application/json': { schema: ACK } } };
const QUOTA_ACK_RESPONSE = { ...ACK_RESPONSE, headers: { 'X-Quota': { schema: { type: 'integer', maximum: 100 } } } };
const ACCEPTED_RESPONSE = { description: 'Accepted', headers: { 'X-Request-Id': { required: true, schema: { type: 'string' } } } };

const DOCUMENT = {
  openapi: '3.2.0',
  info: { title: 'Hooks', version: '1' },
  paths: {
    '/subscribe': {
      post: {
        operationId: 'subscribe',
        callbacks: { onEvent: { '{$request.body#/url}': { post: { operationId: 'receiveEvent', requestBody: { required: true, content: { 'application/json': { schema: EVENT } } }, responses: { 200: ACK_RESPONSE } } } } },
        responses: { 204: { description: 'Subscribed' } },
      },
    },
  },
  webhooks: {
    settled: {
      post: {
        operationId: 'receiveSettlement',
        parameters: [{ name: 'X-Sent', in: 'header', schema: DATE_TIME }, { name: 'tenant', in: 'query', schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: EVENT } } },
        responses: { 200: QUOTA_ACK_RESPONSE, 202: ACCEPTED_RESPONSE, 204: { description: 'No content', headers: { 'X-At': { schema: DATE_TIME } } } },
      },
    },
    searched: {
      post: {
        operationId: 'receiveSearch',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'urgent', in: 'query', schema: { type: 'boolean' } },
          { name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'integer' } } },
          { name: 'X-Count', in: 'header', required: true, schema: { type: 'integer' } },
          { name: 'turn', in: 'cookie', schema: { type: 'integer' } },
        ],
        requestBody: { content: { 'application/json': { schema: EVENT } } },
        responses: { 204: { description: 'No content' } },
      },
    },
    media: {
      post: {
        operationId: 'receiveMedia',
        requestBody: { required: true, content: { 'application/json': { schema: EVENT }, 'application/vnd.ack+json': { schema: ACK } } },
        responses: { 204: { description: 'No content' } },
      },
    },
    plain: {
      post: {
        operationId: 'receivePlain',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } } } },
        responses: { 204: { description: 'No content' } },
      },
    },
  },
  components: { schemas: { Event: { type: 'object', required: ['at'], properties: { at: DATE_TIME } }, Ack: { type: 'object', required: ['seen'], properties: { seen: DATE_TIME } } } },
};

interface Wire { readonly status: number; readonly contentType: string | null; readonly headers: Record<string, unknown>; readonly body: unknown }
type Handler = (request: unknown) => Promise<Wire>;
type Handlers = Record<'webhookReceiveSettlement' | 'webhookReceiveSearch' | 'webhookReceiveMedia' | 'webhookReceivePlain' | 'callbackReceiveEvent', Handler>;
type Port = Record<keyof Handlers, (input: unknown) => Promise<unknown>>;

const scope = fileFixtureScope();
/** One SDK for each validation level, generated once for the file. */
const sdks = {
  full: onceShared(() => loadSdk(scope, 'golem-openapi-inbound-full-', { document: DOCUMENT, name: 'Hooks', dates: 'date', validation: true })),
  sanity: onceShared(() => loadSdk(scope, 'golem-openapi-inbound-sanity-', { document: DOCUMENT, name: 'Hooks', dates: 'date', validation: 'sanity' })),
};

/** The binding of the SDK of a level over a port that records the input of each call and answers `reply`. */
async function bind(level: keyof typeof sdks, reply: unknown, options?: unknown): Promise<{ readonly handlers: Handlers; readonly received: unknown[]; readonly output: string }> {
  const { output } = await sdks[level]();
  const bindHooksInbound = (await importGeneratedModule(output, 'generated SDK')).bindHooksInbound as (port: Port, options?: unknown) => Handlers;
  const received: unknown[] = [];
  const answer = async (input: unknown) => { received.push(input); return reply; };
  return { handlers: bindHooksInbound({ webhookReceiveSettlement: answer, webhookReceiveSearch: answer, webhookReceiveMedia: answer, webhookReceivePlain: answer, callbackReceiveEvent: answer }, options), received, output };
}

const AT = '2025-01-02T03:04:05.000Z';
const REQUEST = { body: { at: AT } };
const NO_CONTENT = { matched: 'status', status: 204, contentType: null, body: undefined, headers: {} };
const OK = { matched: 'status', status: 200, contentType: 'application/json', body: { seen: new Date(AT) }, headers: {} };
const isInputError = (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === true;
const isAppFault = (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === false;

test('a webhook body, query and header date reach the port as a Date', async () => {
  // protects: R-80 an inbound payload is decoded before the port sees it
  const { handlers, received } = await bind('full', OK);
  await handlers.webhookReceiveSettlement({ query: { tenant: 'acme' }, header: { 'X-Sent': AT }, body: { at: AT } });
  assert.deepEqual(received, [{ query: { tenant: 'acme' }, header: { 'X-Sent': new Date(AT) }, body: { at: new Date(AT) } }]);
});

test('a callback payload reaches the port as a Date', async () => {
  // protects: R-80 callbacks convert like webhooks
  const { handlers, received } = await bind('full', OK);
  await handlers.callbackReceiveEvent({ body: { at: AT } });
  assert.deepEqual(received, [{ body: { at: new Date(AT) } }]);
});

test('a bad payload is rejected as input and the port is not called', async () => {
  // protects: R-80 an inbound payload is checked before the port is called
  const { handlers, received } = await bind('full', OK);
  await assert.rejects(handlers.webhookReceiveSettlement({ body: { at: 'yesterday' } }), isInputError);
  await assert.rejects(handlers.webhookReceiveSettlement({ body: {} }), isInputError);
  assert.deepEqual(received, []);
});

test('a header is unchecked by default and checked when the binding names it', async () => {
  // protects: R-87 header checks are off unless named; conversion still rejects a header that is no date
  const request = { header: { 'X-Sent': 'yesterday' }, body: { at: AT } };
  const unchecked = await bind('full', OK);
  await assert.rejects(unchecked.handlers.webhookReceiveSettlement(request), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Deserialization && error.causedByInput === true);
  const checked = await bind('full', OK, { validate: { requestHeaders: true } });
  await assert.rejects(checked.handlers.webhookReceiveSettlement(request), isInputError);
  assert.deepEqual(checked.received, []);
});

test('a response header that converts nothing and breaks its schema is the application\'s error only when responseHeaders is on', async () => {
  // protects: R-87 inbound response headers have validators, off by default; a bad one is the app's fault
  const reply = { ...OK, headers: { 'X-Quota': 500 } };
  const unchecked = await bind('full', reply);
  assert.equal((await unchecked.handlers.webhookReceiveSettlement(REQUEST)).headers['X-Quota'], 500);
  const checked = await bind('full', reply, { validate: { responseHeaders: true } });
  await assert.rejects(checked.handlers.webhookReceiveSettlement(REQUEST), isAppFault);
});

test('a binding refuses a response header level above the SDK level', async () => {
  // protects: R-72, R-87 a level above the SDK's throws ValidationUnavailable when the binding is made
  await assert.rejects(
    bind('sanity', OK, { validate: { responseHeaders: true } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
  );
});

test('the response of the port is encoded: its dates leave as wire strings', async () => {
  // protects: R-80 an inbound response is encoded after the port answers
  const { handlers } = await bind('full', OK);
  assert.deepEqual(await handlers.webhookReceiveSettlement(REQUEST), { status: 200, contentType: 'application/json', headers: {}, body: { seen: AT } });
  const noContent = await bind('full', { ...NO_CONTENT, headers: { 'X-At': new Date(AT) } });
  assert.deepEqual(await noContent.handlers.webhookReceiveSettlement(REQUEST), { status: 204, contentType: null, headers: { 'X-At': AT }, body: undefined });
});

for (const [name, body] of [['a date that is no date', { seen: 'yesterday' }], ['a number for a date', { seen: 5 }], ['a missing field', {}]] as const) {
  test(`a response of the port with ${name} is an error of the application, not of the input`, async () => {
    // protects: R-80, F-777 a bad port response is an app-side LibError and golem picks no status
    const { handlers } = await bind('full', { ...OK, body });
    await assert.rejects(handlers.webhookReceiveSettlement(REQUEST), isAppFault);
  });
}

test('a payload with nothing to convert reaches the port unchanged and its operation has no body codec', async () => {
  // protects: R-80 identity payloads have no codec entry at all
  const { handlers, received, output } = await bind('full', NO_CONTENT);
  const body = { n: 3 };
  assert.deepEqual(await handlers.webhookReceivePlain({ body }), { status: 204, contentType: null, headers: {}, body: undefined });
  assert.deepEqual(received, [{ body }]);
  assert.deepEqual(Object.keys(requireRecord((await importGeneratedModule(output, 'plain codecs', 'dist/codecs/webhookReceivePlain.js')).operationCodecs, 'plain codecs')), ['input']);
});

test('a converted port response body is checked once, by its conversion, and any other body by its wire check', async () => {
  // protects: R-86, T-711 the converted body gets its plain-value check only; the wire check of its response root is not run again
  const { output } = await sdks.full();
  const codecs = requireRecord((await importGeneratedModule(output, 'settlement codecs', 'dist/codecs/webhookReceiveSettlement.js')).operationCodecs, 'settlement codecs') as {
    responses: Record<string, (value: unknown, all: boolean) => readonly unknown[]>;
    decode: Record<string, (value: unknown, options?: { validate?: unknown }) => unknown>;
  };
  const wireChecked: unknown[] = [];
  const levels: unknown[] = [];
  const [check, toWire] = [codecs.responses['200:application/json']!, codecs.decode['200:application/json']!];
  codecs.responses['200:application/json'] = (value, all) => { wireChecked.push(value); return check(value, all); };
  codecs.decode['200:application/json'] = (value, options) => { levels.push(options?.validate); return toWire(value, options); };
  try {
    const { handlers } = await bind('full', OK);
    await handlers.webhookReceiveSettlement(REQUEST);
  } finally {
    [codecs.responses['200:application/json'], codecs.decode['200:application/json']] = [check, toWire];
  }
  assert.deepEqual(levels, [true]);
  assert.deepEqual(wireChecked, []);
});

test('request header names match the declared names in any letter case', async () => {
  // protects: T-711 a framework gives lowercase header names; the binding matches them to the declared names
  const { handlers, received } = await bind('full', OK, { validate: { requestHeaders: true } });
  await handlers.webhookReceiveSettlement({ header: { 'x-sent': AT }, body: { at: AT } });
  assert.deepEqual(received, [{ header: { 'X-Sent': new Date(AT) }, body: { at: new Date(AT) } }]);
});

test('response header names match the declared names in any letter case', async () => {
  // protects: T-711 the port may answer lowercase header names; they are checked and written under the declared names
  const { handlers } = await bind('full', { ...OK, headers: { 'x-quota': 5 } }, { validate: { responseHeaders: true } });
  assert.deepEqual((await handlers.webhookReceiveSettlement(REQUEST)).headers, { 'X-Quota': 5 });
  const bad = await bind('full', { ...OK, headers: { 'x-quota': 500 } }, { validate: { responseHeaders: true } });
  await assert.rejects(bad.handlers.webhookReceiveSettlement(REQUEST), isAppFault);
});

for (const [name, options, headers, expected] of [
  ['absent with responseHeaders off', undefined, {}, 'accepted'],
  ['absent with responseHeaders on', { validate: { responseHeaders: true } }, {}, 'fault'],
  ['present in lowercase with responseHeaders on', { validate: { responseHeaders: true } }, { 'x-request-id': 'r1' }, 'accepted'],
] as const) {
  test(`a required response header is reported when it is absent and responseHeaders is on: ${name}`, async () => {
    // protects: R-87, T-710 an absent required response header is the application's error when header checks are on
    const { handlers } = await bind('full', { matched: 'status', status: 202, contentType: null, body: undefined, headers }, options);
    const answered = handlers.webhookReceiveSettlement(REQUEST);
    if (expected === 'fault') await assert.rejects(answered, isAppFault);
    else assert.equal((await answered).status, 202);
  });
}

for (const [name, reply, options, expected] of [
  ['an undeclared status', { ...NO_CONTENT, status: 500 }, undefined, 'fault'],
  ['an undeclared content type', { ...OK, contentType: 'text/plain', body: 'x' }, undefined, 'fault'],
  ['a content type with a charset parameter, which the client matches too', { ...OK, contentType: 'application/json; charset=utf-8' }, undefined, 'accepted'],
  ['a body for a response declared without content', { ...NO_CONTENT, contentType: 'application/json' }, undefined, 'fault'],
  ['an undeclared status with response checks off', { ...NO_CONTENT, status: 500 }, { validate: { response: false } }, 'accepted'],
] as const) {
  test(`a port response with ${name}`, async () => {
    // protects: T-711 a response whose status or media type the operation does not declare is the application's error when response checks are on
    const { handlers } = await bind('full', reply, options);
    const answered = handlers.webhookReceiveSettlement(REQUEST);
    if (expected === 'fault') await assert.rejects(answered, isAppFault);
    else assert.equal((await answered).status, reply.status);
  });
}

test('path, query, header and cookie text decodes to the types the schema declares', async () => {
  // protects: T-711 a framework gives text; the binding decodes it as a Nest query does, and text that does not fit is rejected as input
  const { handlers, received } = await bind('full', NO_CONTENT, { validate: { requestHeaders: true } });
  await handlers.webhookReceiveSearch({ query: { limit: '5', urgent: 'true', ids: ['1', '2'] }, header: { 'x-count': '7' }, cookie: { turn: '3' } });
  assert.deepEqual(received, [{ query: { limit: 5, urgent: true, ids: [1, 2] }, header: { 'X-Count': 7 }, cookie: { turn: 3 } }]);
  await assert.rejects(handlers.webhookReceiveSearch({ query: { limit: '5x' }, header: { 'X-Count': '7' } }), isInputError);
  await assert.rejects(handlers.webhookReceiveSearch({ query: { urgent: 'yes' }, header: { 'X-Count': '7' } }), isInputError);
});

test('an absent optional body reaches the port as no body', async () => {
  // protects: T-711 an optional body that is absent is not a field of the port input
  const { handlers, received } = await bind('full', NO_CONTENT, { validate: { requestHeaders: true } });
  await handlers.webhookReceiveSearch({ header: { 'X-Count': '1' } });
  assert.deepEqual(received, [{ header: { 'X-Count': 1 } }]);
  await assert.rejects(handlers.webhookReceiveMedia({}), isInputError);
});

for (const [name, request, expected] of [
  ['the first media type', { contentType: 'application/json', value: { at: AT } }, { at: new Date(AT) }],
  ['the second media type', { contentType: 'application/vnd.ack+json', value: { seen: AT } }, { seen: new Date(AT) }],
] as const) {
  test(`a request body of ${name} converts by its own media type`, async () => {
    // protects: T-711 a body with several media types is { contentType, value } and converts through the codec of its media type
    const { handlers, received } = await bind('full', NO_CONTENT);
    await handlers.webhookReceiveMedia({ body: request });
    assert.deepEqual(received, [{ body: { contentType: request.contentType, value: expected } }]);
  });
}

test('a request body of an undeclared media type is rejected as input', async () => {
  // protects: T-711 the body of several media types names a declared one
  const { handlers, received } = await bind('full', NO_CONTENT);
  await assert.rejects(handlers.webhookReceiveMedia({ body: { contentType: 'text/plain', value: 'x' } }), isInputError);
  await assert.rejects(handlers.webhookReceiveMedia({ body: { contentType: 'application/json', value: { seen: AT } } }), isInputError);
  assert.deepEqual(received, []);
});
