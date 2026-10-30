import assert from 'node:assert/strict';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { importGeneratedModule, requireRecord } from './helpers.js';
import { loadSdk } from './sdk-client-fixture.js';

// The SDK converts and checks the traffic of its webhooks and callbacks like its outbound traffic (R-80): the binding takes the app's port and returns one handler per inbound operation.

const DATE_TIME = { type: 'string', format: 'date-time' };
const EVENT = { $ref: '#/components/schemas/Event' };
const ACK = { $ref: '#/components/schemas/Ack' };
const ACK_RESPONSE = { description: 'Accepted', content: { 'application/json': { schema: ACK } } };

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
        responses: { 200: ACK_RESPONSE, 204: { description: 'No content', headers: { 'X-At': { schema: DATE_TIME } } } },
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
type Handlers = Record<'webhookReceiveSettlement' | 'webhookReceivePlain' | 'callbackReceiveEvent', Handler>;
type Port = Record<keyof Handlers, (input: unknown) => Promise<unknown>>;

/** The SDK generated once per test, and its binding over a port that records the input of each call and answers `reply`. */
async function bind(t: Parameters<typeof loadSdk>[0], reply: unknown, options?: unknown): Promise<{ readonly handlers: Handlers; readonly received: unknown[]; readonly output: string }> {
  const sdk = await loadSdk(t, 'golem-openapi-inbound-binding-', { document: DOCUMENT, name: 'Hooks', dates: 'date', validation: true });
  const bindHooksInbound = (await importGeneratedModule(sdk.output, 'generated SDK')).bindHooksInbound as (port: Port, options?: unknown) => Handlers;
  const received: unknown[] = [];
  const answer = async (input: unknown) => { received.push(input); return reply; };
  return { handlers: bindHooksInbound({ webhookReceiveSettlement: answer, webhookReceivePlain: answer, callbackReceiveEvent: answer }, options), received, output: sdk.output };
}

const OK = { matched: 'status', status: 200, contentType: 'application/json', body: { seen: new Date('2025-01-02T03:04:05Z') }, headers: {} };
const isInputError = (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === true;

test('a webhook body, query and header date reach the port as a Date', async t => {
  // protects: R-80 an inbound payload is decoded before the port sees it
  const { handlers, received } = await bind(t, OK);
  await handlers.webhookReceiveSettlement({ query: { tenant: 'acme' }, header: { 'X-Sent': '2025-01-02T03:04:05Z' }, body: { at: '2025-01-02T03:04:05.000Z' } });
  assert.deepEqual(received, [{ query: { tenant: 'acme' }, header: { 'X-Sent': new Date('2025-01-02T03:04:05Z') }, body: { at: new Date('2025-01-02T03:04:05Z') } }]);
});

test('a callback payload reaches the port as a Date', async t => {
  // protects: R-80 callbacks convert like webhooks
  const { handlers, received } = await bind(t, OK);
  await handlers.callbackReceiveEvent({ body: { at: '2025-01-02T03:04:05.000Z' } });
  assert.deepEqual(received, [{ body: { at: new Date('2025-01-02T03:04:05Z') } }]);
});

test('a bad payload is rejected as input and the port is not called', async t => {
  // protects: R-80 an inbound payload is checked before the port is called
  const { handlers, received } = await bind(t, OK);
  await assert.rejects(handlers.webhookReceiveSettlement({ body: { at: 'yesterday' } }), isInputError);
  await assert.rejects(handlers.webhookReceiveSettlement({ body: {} }), isInputError);
  assert.deepEqual(received, []);
});

test('a header is unchecked by default and checked when the binding names it', async t => {
  // protects: R-87 header checks are off unless named; conversion still rejects a header that is no date
  const request = { header: { 'X-Sent': 'yesterday' }, body: { at: '2025-01-02T03:04:05Z' } };
  const unchecked = await bind(t, OK);
  await assert.rejects(unchecked.handlers.webhookReceiveSettlement(request), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Deserialization && error.causedByInput === true);
  const checked = await bind(t, OK, { validate: { requestHeaders: true } });
  await assert.rejects(checked.handlers.webhookReceiveSettlement(request), isInputError);
  assert.deepEqual(checked.received, []);
});

test('the response of the port is encoded: its dates leave as wire strings', async t => {
  // protects: R-80 an inbound response is encoded after the port answers
  const { handlers } = await bind(t, OK);
  assert.deepEqual(await handlers.webhookReceiveSettlement({ body: { at: '2025-01-02T03:04:05Z' } }), { status: 200, contentType: 'application/json', headers: {}, body: { seen: '2025-01-02T03:04:05.000Z' } });
  const noContent = await bind(t, { matched: 'status', status: 204, contentType: null, body: undefined, headers: { 'X-At': new Date('2025-01-02T03:04:05Z') } });
  assert.deepEqual(await noContent.handlers.webhookReceiveSettlement({ body: { at: '2025-01-02T03:04:05Z' } }), { status: 204, contentType: null, headers: { 'X-At': '2025-01-02T03:04:05.000Z' }, body: undefined });
});

test('a response of the port that breaks the schema is an error of the application, not of the input', async t => {
  // protects: R-80, F-777 a bad port response is an app-side LibError and golem picks no status
  for (const body of [{ seen: 'yesterday' }, { seen: 5 }, {}]) {
    const { handlers } = await bind(t, { ...OK, body });
    await assert.rejects(
      handlers.webhookReceiveSettlement({ body: { at: '2025-01-02T03:04:05Z' } }),
      (error: unknown) => error instanceof LibError && error.causedByInput === false,
    );
  }
});

test('a payload with nothing to convert reaches the port unchanged and its operation has no body codec', async t => {
  // protects: R-80 identity payloads have no codec entry at all
  const { handlers, received, output } = await bind(t, { matched: 'status', status: 204, contentType: null, body: undefined, headers: {} });
  const body = { n: 3 };
  assert.deepEqual(await handlers.webhookReceivePlain({ body }), { status: 204, contentType: null, headers: {}, body: undefined });
  assert.deepEqual(received, [{ body }]);
  assert.deepEqual(Object.keys(requireRecord((await importGeneratedModule(output, 'plain codecs', 'dist/codecs/webhookReceivePlain.js')).operationCodecs, 'plain codecs')), ['input']);
});
