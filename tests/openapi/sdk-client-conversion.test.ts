import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, importGeneratedModule, isGeneratedClientClass, requireRecord } from './helpers.js';

// The client converts what it carries (R-80): bodies and stream items arrive and leave in their plain form.

const JSON_BODY = (schema: unknown) => ({ 'application/json': { schema } });
const EVENT = { $ref: '#/components/schemas/Event' };
const INLINE = { type: 'object', additionalProperties: false, required: ['when'], properties: { when: { type: 'string', format: 'date-time' } } };
const PLAIN = { $ref: '#/components/schemas/Plain' };
const COMPOSED = { allOf: [{ $ref: '#/components/schemas/Stamp' }, { type: 'object', required: ['note'], properties: { note: { type: 'string' } } }] };

const DOCUMENT = {
  openapi: '3.2.0',
  info: { title: 'Events', version: '1' },
  paths: {
    '/events': { post: { operationId: 'createEvent', requestBody: { required: true, content: JSON_BODY(EVENT) }, responses: { 201: { description: 'Created', content: JSON_BODY(EVENT) } } } },
    '/inline': { post: { operationId: 'echoInline', requestBody: { required: true, content: JSON_BODY(INLINE) }, responses: { 200: { description: 'Echo', content: JSON_BODY(INLINE) } } } },
    '/plain': { post: { operationId: 'echoPlain', requestBody: { required: true, content: JSON_BODY(PLAIN) }, responses: { 200: { description: 'Echo', content: JSON_BODY(PLAIN) } } } },
    '/form': { post: { operationId: 'submitForm', requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: INLINE } } }, responses: { 204: { description: 'Done' } } } },
    '/composed': { post: { operationId: 'echoComposed', requestBody: { required: true, content: JSON_BODY(COMPOSED) }, responses: { 200: { description: 'Echo', content: JSON_BODY(COMPOSED) } } } },
    '/upload': { post: { operationId: 'uploadForm', requestBody: { required: true, content: { 'multipart/form-data': { schema: INLINE } } }, responses: { 204: { description: 'Done' } } } },
    '/note': { post: { operationId: 'sendNote', requestBody: { required: true, content: { 'text/plain': { schema: { type: 'string', format: 'date-time' } } } }, responses: { 204: { description: 'Done' } } } },
    '/stream': { get: { operationId: 'streamEvents', responses: { 200: { description: 'Events', content: { 'application/x-ndjson': { itemSchema: EVENT } } } } } },
  },
  components: { schemas: {
    Event: { type: 'object', additionalProperties: false, required: ['at', 'day'], properties: { at: { type: 'string', format: 'date-time' }, day: { type: 'string', format: 'date' } } },
    Plain: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    Stamp: { type: 'object', required: ['at'], properties: { at: { type: 'string', format: 'date-time' } } },
  } },
};

type Operation = { execute(input: unknown): Promise<{ status: number; body: unknown }> };
type EventsClient = Record<string, () => Operation>;

interface Fetched { readonly body: unknown }

/** Generates the SDK with `dates` and returns a client whose fetch answers `reply` and records the body each request sends, and the folder of the SDK. */
async function loadClient(t: Parameters<typeof createFixtureProject>[0], dates: 'date' | 'temporal', reply: () => Response, sent: Fetched[], validation = true): Promise<{ readonly client: EventsClient; readonly output: string }> {
  const output = path.join(createFixtureProject(t, `golem-openapi-client-conversion-${dates}-`), 'sdk');
  await generateMaterializedSdk(DOCUMENT, { output, name: 'Events', profile: { mobx: false, validation, allowAny: false }, dates });
  compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
  const sdk = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated SDK');
  assert.ok(isGeneratedClientClass(sdk.EventsClient), 'generated client');
  const client = new sdk.EventsClient({
    baseUrl: 'https://api.test',
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ body: typeof init?.body === 'string' && new Headers(init.headers).get('content-type') === 'application/json' ? JSON.parse(init.body) : init?.body });
      return reply();
    },
  }) as unknown as EventsClient;
  return { client, output };
}

const WIRE_EVENT = { at: '2025-01-02T03:04:05Z', day: '2025-01-02' };

test('the client returns Date values for a response body and sends them as wire strings', async t => {
  // protects: R-80 the client converts a $ref body in both directions
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', () => Response.json(WIRE_EVENT, { status: 201 }), sent);
  const response = await client.createEvent!().execute({ body: { at: new Date('2025-01-02T03:04:05Z'), day: '2025-01-02' } });
  assert.deepEqual(sent, [{ body: { at: '2025-01-02T03:04:05.000Z', day: '2025-01-02' } }]);
  const body = response.body as { at: unknown; day: unknown };
  assert.ok(body.at instanceof Date);
  assert.equal((body.at as Date).toISOString(), '2025-01-02T03:04:05.000Z');
  assert.equal(body.day, '2025-01-02');
});

test('with dates: temporal the client returns Temporal values for a $ref body and sends their wire strings', async t => {
  // protects: R-80 Temporal date-time and date convert in a $ref body, both directions
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'temporal', () => Response.json(WIRE_EVENT, { status: 201 }), sent);
  const created = await client.createEvent!().execute({ body: { at: Temporal.Instant.from('2025-01-02T03:04:05Z'), day: Temporal.PlainDate.from('2025-01-02') } });
  const event = created.body as { at: unknown; day: unknown };
  assert.ok(event.at instanceof Temporal.Instant);
  assert.ok(event.day instanceof Temporal.PlainDate);
  assert.deepEqual(sent, [{ body: { at: '2025-01-02T03:04:05Z', day: '2025-01-02' } }]);
});

test('with dates: temporal the client converts an inline body', async t => {
  // protects: R-80 Temporal values convert in an inline body, both directions
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'temporal', () => Response.json({ when: '2025-01-02T03:04:05Z' }), sent);
  const inline = await client.echoInline!().execute({ body: { when: Temporal.Instant.from('2025-01-02T03:04:05Z') } });
  assert.ok((inline.body as { when: unknown }).when instanceof Temporal.Instant);
  assert.deepEqual(sent, [{ body: { when: '2025-01-02T03:04:05Z' } }]);
});

test('with dates: temporal the client converts each stream item', async t => {
  // protects: R-80 Temporal values convert in a stream item
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'temporal', () => new Response(`${JSON.stringify(WIRE_EVENT)}\n${JSON.stringify(WIRE_EVENT)}\n`, { headers: { 'content-type': 'application/x-ndjson' } }), sent);
  const streamed = await client.streamEvents!().execute({});
  const items: unknown[] = [];
  for await (const item of streamed.body as AsyncIterable<{ at: unknown }>) items.push(item.at);
  assert.equal(items.length, 2);
  assert.ok(items.every(at => at instanceof Temporal.Instant));
});

test('a body with nothing to convert passes through unchanged', async t => {
  // protects: R-80 identity bodies have no codec: the value is the same object
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', () => Response.json({ id: 'a' }), sent);
  const response = await client.echoPlain!().execute({ body: { id: 'a' } });
  assert.deepEqual(sent, [{ body: { id: 'a' } }]);
  assert.deepEqual(response.body, { id: 'a' });
});

test('a response with an invalid date is rejected as a validation error caused by input, and a bad request never reaches fetch', async t => {
  // protects: R-80 the wire check runs before decode, the plain input check before encode
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', () => Response.json({ at: 'not a date', day: '2025-01-02' }, { status: 201 }), sent);
  await assert.rejects(
    client.createEvent!().execute({ body: { at: new Date('2025-01-02T03:04:05Z'), day: '2025-01-02' } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === true,
  );
  sent.length = 0;
  await assert.rejects(
    client.createEvent!().execute({ body: { at: '2025-01-02T03:04:05Z', day: 3 } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === true,
  );
  assert.deepEqual(sent, []);
});

test('a form-urlencoded body with a date is sent with the date as its wire string', async t => {
  // protects: R-80 the encoder runs for every request media type, so a form field holds the wire string
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', () => new Response(null, { status: 204 }), sent);
  await client.submitForm!().execute({ body: { when: new Date('2025-01-02T03:04:05Z') } });
  assert.deepEqual(sent, [{ body: 'when=2025-01-02T03%3A04%3A05.000Z' }]);
});

test('an allOf body with a date converts in both directions', async t => {
  // protects: R-80 a composed body converts the member fields it merges
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', () => Response.json({ at: '2025-01-02T03:04:05Z', note: 'hi' }), sent);
  const response = await client.echoComposed!().execute({ body: { at: new Date('2025-01-02T03:04:05Z'), note: 'hi' } });
  assert.deepEqual(sent, [{ body: { at: '2025-01-02T03:04:05.000Z', note: 'hi' } }]);
  const body = response.body as { at: unknown; note: unknown };
  assert.ok(body.at instanceof Date);
  assert.equal(body.note, 'hi');
});

test('a multipart body with a date is sent with the date as its wire string', async t => {
  // protects: R-80 the encoder runs for a multipart request media type
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', () => new Response(null, { status: 204 }), sent);
  await client.uploadForm!().execute({ body: { when: new Date('2025-01-02T03:04:05Z') } });
  assert.ok(sent[0]?.body instanceof FormData);
  assert.equal(sent[0].body.get('when'), '2025-01-02T03:04:05.000Z');
});

test('a text body with a date is sent as its wire string', async t => {
  // protects: R-80 the encoder runs for a text request media type
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', () => new Response(null, { status: 204 }), sent);
  await client.sendNote!().execute({ body: new Date('2025-01-02T03:04:05Z') });
  assert.deepEqual(sent, [{ body: '2025-01-02T03:04:05.000Z' }]);
});

test('with validation off a response with an invalid date is a deserialization error caused by input', async t => {
  // protects: R-80 decode rejects a bad wire date when no validator runs before it
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', () => Response.json({ at: 'not a date', day: '2025-01-02' }, { status: 201 }), sent, false);
  await assert.rejects(
    client.createEvent!().execute({ body: { at: new Date('2025-01-02T03:04:05Z'), day: '2025-01-02' } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Deserialization && error.causedByInput === true,
  );
});

test('an operation with an identity body has no encode or decode entry in its codec module', async t => {
  // protects: R-80 identity bodies have no codec entry at all
  const { output } = await loadClient(t, 'date', () => Response.json({ id: 'a' }), []);
  const codecs = (name: string) => importGeneratedModule(output, `${name} codecs`, `dist/codecs/${name}.js`);
  assert.deepEqual(Object.keys(requireRecord((await codecs('echoPlain')).operationCodecs, 'echoPlain codecs')), ['input', 'responses']);
  assert.deepEqual(Object.keys(requireRecord((await codecs('createEvent')).operationCodecs, 'createEvent codecs')), ['input', 'responses', 'encode', 'decode']);
});
