import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, isGeneratedClientClass, requireRecord } from './helpers.js';

// The client converts what it carries (R-80): bodies and stream items arrive and leave in their plain form.

const JSON_BODY = (schema: unknown) => ({ 'application/json': { schema } });
const EVENT = { $ref: '#/components/schemas/Event' };
const INLINE = { type: 'object', additionalProperties: false, required: ['when'], properties: { when: { type: 'string', format: 'date-time' } } };
const PLAIN = { $ref: '#/components/schemas/Plain' };

const DOCUMENT = {
  openapi: '3.2.0',
  info: { title: 'Events', version: '1' },
  paths: {
    '/events': { post: { operationId: 'createEvent', requestBody: { required: true, content: JSON_BODY(EVENT) }, responses: { 201: { description: 'Created', content: JSON_BODY(EVENT) } } } },
    '/inline': { post: { operationId: 'echoInline', requestBody: { required: true, content: JSON_BODY(INLINE) }, responses: { 200: { description: 'Echo', content: JSON_BODY(INLINE) } } } },
    '/plain': { post: { operationId: 'echoPlain', requestBody: { required: true, content: JSON_BODY(PLAIN) }, responses: { 200: { description: 'Echo', content: JSON_BODY(PLAIN) } } } },
    '/form': { post: { operationId: 'submitForm', requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: INLINE } } }, responses: { 204: { description: 'Done' } } } },
    '/stream': { get: { operationId: 'streamEvents', responses: { 200: { description: 'Events', content: { 'application/x-ndjson': { itemSchema: EVENT } } } } } },
  },
  components: { schemas: {
    Event: { type: 'object', additionalProperties: false, required: ['at', 'day'], properties: { at: { type: 'string', format: 'date-time' }, day: { type: 'string', format: 'date' } } },
    Plain: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
  } },
};

type Operation = { execute(input: unknown): Promise<{ status: number; body: unknown }> };
type EventsClient = Record<string, () => Operation>;

interface Fetched { readonly body: unknown }

/** Generates the SDK with `dates` and returns a client whose fetch answers `reply` and records the JSON each request sends. */
async function loadClient(t: Parameters<typeof createFixtureProject>[0], dates: 'date' | 'temporal', reply: () => Response, sent: Fetched[]): Promise<EventsClient> {
  const output = path.join(createFixtureProject(t, `golem-openapi-client-conversion-${dates}-`), 'sdk');
  await generateMaterializedSdk(DOCUMENT, { output, name: 'Events', profile: { mobx: false, validation: true, allowAny: false }, dates });
  compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
  const sdk = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated SDK');
  assert.ok(isGeneratedClientClass(sdk.EventsClient), 'generated client');
  return new sdk.EventsClient({
    baseUrl: 'https://api.test',
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ body: typeof init?.body === 'string' && new Headers(init.headers).get('content-type') === 'application/json' ? JSON.parse(init.body) : init?.body });
      return reply();
    },
  }) as unknown as EventsClient;
}

const WIRE_EVENT = { at: '2025-01-02T03:04:05Z', day: '2025-01-02' };

test('the client returns Date values for a response body and sends them as wire strings', async t => {
  // protects: R-80 the client converts a $ref body in both directions
  const sent: Fetched[] = [];
  const client = await loadClient(t, 'date', () => Response.json(WIRE_EVENT, { status: 201 }), sent);
  const response = await client.createEvent!().execute({ body: { at: new Date('2025-01-02T03:04:05Z'), day: '2025-01-02' } });
  assert.deepEqual(sent, [{ body: { at: '2025-01-02T03:04:05.000Z', day: '2025-01-02' } }]);
  const body = response.body as { at: unknown; day: unknown };
  assert.ok(body.at instanceof Date);
  assert.equal((body.at as Date).toISOString(), '2025-01-02T03:04:05.000Z');
  assert.equal(body.day, '2025-01-02');
});

test('with dates: temporal the client returns Temporal values for date-time and date, and sends their wire strings', async t => {
  // protects: R-80 Temporal values convert in a $ref body, an inline body and a stream item
  const sent: Fetched[] = [];
  let replies: () => Response = () => Response.json(WIRE_EVENT, { status: 201 });
  const client = await loadClient(t, 'temporal', () => replies(), sent);
  const created = await client.createEvent!().execute({ body: { at: Temporal.Instant.from('2025-01-02T03:04:05Z'), day: Temporal.PlainDate.from('2025-01-02') } });
  const event = created.body as { at: unknown; day: unknown };
  assert.ok(event.at instanceof Temporal.Instant);
  assert.ok(event.day instanceof Temporal.PlainDate);
  replies = () => Response.json({ when: '2025-01-02T03:04:05Z' });
  const inline = await client.echoInline!().execute({ body: { when: Temporal.Instant.from('2025-01-02T03:04:05Z') } });
  assert.ok((inline.body as { when: unknown }).when instanceof Temporal.Instant);
  replies = () => new Response(`${JSON.stringify(WIRE_EVENT)}\n${JSON.stringify(WIRE_EVENT)}\n`, { headers: { 'content-type': 'application/x-ndjson' } });
  const streamed = await client.streamEvents!().execute({});
  const items: unknown[] = [];
  for await (const item of streamed.body as AsyncIterable<{ at: unknown }>) items.push(item.at);
  assert.equal(items.length, 2);
  assert.ok(items.every(at => at instanceof Temporal.Instant));
  assert.deepEqual(sent.map(request => request.body), [
    { at: '2025-01-02T03:04:05Z', day: '2025-01-02' },
    { when: '2025-01-02T03:04:05Z' },
    undefined,
  ]);
});

test('a body with nothing to convert passes through unchanged', async t => {
  // protects: R-80 identity bodies have no codec: the value is the same object
  const sent: Fetched[] = [];
  const client = await loadClient(t, 'date', () => Response.json({ id: 'a' }), sent);
  const response = await client.echoPlain!().execute({ body: { id: 'a' } });
  assert.deepEqual(sent, [{ body: { id: 'a' } }]);
  assert.deepEqual(response.body, { id: 'a' });
});

test('a response with an invalid date is rejected as a validation error caused by input, and a bad request never reaches fetch', async t => {
  // protects: R-80 the wire check runs before decode, the plain input check before encode
  const sent: Fetched[] = [];
  const client = await loadClient(t, 'date', () => Response.json({ at: 'not a date', day: '2025-01-02' }, { status: 201 }), sent);
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
  const client = await loadClient(t, 'date', () => new Response(null, { status: 204 }), sent);
  await client.submitForm!().execute({ body: { when: new Date('2025-01-02T03:04:05Z') } });
  assert.deepEqual(sent, [{ body: 'when=2025-01-02T03%3A04%3A05.000Z' }]);
});
