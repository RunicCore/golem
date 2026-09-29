import type { TestContext } from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { normalizeDocument, writeSdk } from '#openapi/generator';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isAsyncIterable,
  isGeneratedClientClass,
  requireRecord,
  writeGeneratedSdk,
} from './helpers.js';

const RS = '\u001e';

function streamResponse(
  contentType: string,
  chunks: readonly Uint8Array[],
  onCancel?: () => void,
  onStream?: (stream: ReadableStream<Uint8Array>) => void,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  onStream?.(body);
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function hangingResponse(
  contentType: string,
  first: Uint8Array,
  onCancel: () => void,
  onStream?: (stream: ReadableStream<Uint8Array>) => void,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
    cancel() {
      onCancel();
    },
  });
  onStream?.(body);
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function streamLocked(ref: { current?: ReadableStream<Uint8Array> }): boolean | undefined {
  return ref.current?.locked;
}

async function loadClient(
  t: TestContext,
  document: unknown,
  name: string,
  profile: { mobx: boolean; validation: boolean; ajvStandalone?: boolean },
) {
  const output = path.join(createFixtureProject(t, 'runic-openapi-streams-'), 'sdk');
  await generateMaterializedSdk(document, { output, name, profile });
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

function streamDoc(contentType: string, itemSchema: unknown): Record<string, unknown> {
  return {
    openapi: '3.2.0',
    info: { title: 'Streams', version: '1' },
    paths: {
      '/stream': {
        get: {
          operationId: 'readStream',
          responses: {
            200: {
              description: 'stream',
              content: { [contentType]: { itemSchema } },
            },
          },
        },
      },
    },
  };
}

const objectItem = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' } },
};

test('JSON-seq reads RS-framed multiline records across chunks and ignores consecutive RS', async (t) => {
  const Client = await loadClient(
    t, streamDoc('application/json-seq', objectItem),
    'Streams',
    { mobx: false, validation: false },
  );
  const encoder = new TextEncoder();
  const payload = `${RS}{\n  "id": 1\n}\n${RS}${RS}{"id":2}\n`;
  const bytes = encoder.encode(payload);
  const sourceRef: { current?: ReadableStream<Uint8Array> } = {};
  const client = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse('application/json-seq', [
      bytes.slice(0, 8),
      bytes.slice(8),
    ], undefined, stream => { sourceRef.current = stream; }),
  });
  const stream = (await client.readStream().execute({})).body;
  assert.equal(isAsyncIterable(stream), true);
  if (!isAsyncIterable(stream)) throw new TypeError('json-seq stream');
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
  assert.equal(streamLocked(sourceRef), false, 'reader lock is released after EOF');
});

test('JSON-seq rejects truncated primitives at EOF and malformed records, cancelling the reader', async (t) => {
  const Client = await loadClient(
    t, streamDoc('application/json-seq', { type: 'number' }),
    'Streams',
    { mobx: false, validation: false },
  );
  let cancelled = false;
  const sourceRef: { current?: ReadableStream<Uint8Array> } = {};
  const client = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse(
      'application/json-seq',
      [new TextEncoder().encode(`${RS}1`)],
      () => {
        cancelled = true;
      },
      stream => { sourceRef.current = stream; },
    ),
  });
  const stream = (await client.readStream().execute({})).body;
  assert.equal(isAsyncIterable(stream), true);
  if (!isAsyncIterable(stream)) throw new TypeError('truncated stream');
  await assert.rejects(async () => {
    for await (const item of stream) assert.equal(item, undefined);
  }, /Malformed JSON text sequence|truncated/);
  assert.equal(cancelled, false, 'EOF on a closed source does not cancel the underlying stream');
  assert.equal(streamLocked(sourceRef), false, 'reader lock is released after malformed EOF');

  cancelled = false;
  sourceRef.current = undefined;
  const malformed = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => hangingResponse(
      'application/json-seq',
      new TextEncoder().encode(`${RS}{not-json}\n${RS}`),
      () => {
        cancelled = true;
      },
      stream => { sourceRef.current = stream; },
    ),
  });
  const bad = (await malformed.readStream().execute({})).body;
  if (!isAsyncIterable(bad)) throw new TypeError('malformed stream');
  await assert.rejects(async () => {
    for await (const item of bad) assert.equal(item, undefined);
  }, /Malformed JSON text sequence/);
  assert.equal(cancelled, true);
  assert.equal(streamLocked(sourceRef), false, 'reader lock is released after malformed JSON');

  cancelled = false;
  sourceRef.current = undefined;
  const missingRs = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => hangingResponse(
      'application/json-seq',
      new TextEncoder().encode(`{"id":1}\n${RS}`),
      () => {
        cancelled = true;
      },
      stream => { sourceRef.current = stream; },
    ),
  });
  const missingRsStream = (await missingRs.readStream().execute({})).body;
  if (!isAsyncIterable(missingRsStream)) throw new TypeError('missing RS stream');
  await assert.rejects(async () => {
    for await (const item of missingRsStream) assert.equal(item, undefined);
  }, /RS|JSON text sequence/);
  assert.equal(cancelled, true);
  assert.equal(streamLocked(sourceRef), false, 'reader lock is released after missing RS');

  cancelled = false;
  sourceRef.current = undefined;
  const invalidUtf8 = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => hangingResponse(
      'application/json-seq',
      Uint8Array.from([0x1e, 0x22, 0xc3, 0x22, 0x1e]),
      () => {
        cancelled = true;
      },
      stream => { sourceRef.current = stream; },
    ),
  });
  const invalidUtf8Stream = (await invalidUtf8.readStream().execute({})).body;
  if (!isAsyncIterable(invalidUtf8Stream)) throw new TypeError('invalid UTF-8 stream');
  await assert.rejects(async () => {
    for await (const item of invalidUtf8Stream) assert.equal(item, undefined);
  }, /The encoded data was not valid for encoding utf-8/);
  assert.equal(cancelled, true);
  assert.equal(streamLocked(sourceRef), false, 'reader lock is released after invalid UTF-8');

  sourceRef.current = undefined;
  const noRs = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse(
      'application/json-seq',
      [new TextEncoder().encode('{}\n')],
      undefined,
      stream => { sourceRef.current = stream; },
    ),
  });
  const noRsStream = (await noRs.readStream().execute({})).body;
  if (!isAsyncIterable(noRsStream)) throw new TypeError('no RS stream');
  await assert.rejects(async () => {
    for await (const item of noRsStream) assert.equal(item, undefined);
  }, /requires an RS before the first record/);
  assert.equal(streamLocked(sourceRef), false, 'reader lock is released after a body with no RS at all');
});

test('JSON-seq reads single-byte chunks, buffering a split multi-byte UTF-8 character', async (t) => {
  const Client = await loadClient(
    t, streamDoc('application/json-seq', objectItem),
    'Streams',
    { mobx: false, validation: false },
  );
  const bytes = new TextEncoder().encode(`${RS}{\n  "label": "café"\n}\n`);
  const client = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse(
      'application/json-seq',
      Array.from(bytes, (byte) => Uint8Array.of(byte)),
    ),
  });
  const stream = (await client.readStream().execute({})).body;
  if (!isAsyncIterable(stream)) throw new TypeError('byte-chunked stream');
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  assert.deepEqual(items, [{ label: 'café' }]);
});

test('JSON-seq validates with an ajvStandalone profile', async (t) => {
  const OnClient = await loadClient(
    t, streamDoc('application/json-seq', objectItem),
    'Streams',
    { mobx: false, validation: true, ajvStandalone: true },
  );
  const valid = new OnClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse('application/json-seq', [new TextEncoder().encode(`${RS}{"id":1}\n`)]),
  });
  const validStream = (await valid.readStream().execute({})).body;
  if (!isAsyncIterable(validStream)) throw new TypeError('ajvStandalone valid stream');
  const values: unknown[] = [];
  for await (const item of validStream) values.push(item);
  assert.deepEqual(values, [{ id: 1 }]);

  const invalid = new OnClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse('application/json-seq', [new TextEncoder().encode(`${RS}{}\n`)]),
  });
  const invalidStream = (await invalid.readStream().execute({})).body;
  if (!isAsyncIterable(invalidStream)) throw new TypeError('ajvStandalone invalid stream');
  await assert.rejects(async () => {
    for await (const item of invalidStream) assert.equal(item, undefined);
  }, /API data validation failed\./);
});

test('JSON-seq yields delimited numbers and empty streams, SSE stays an event envelope', async (t) => {
  const Client = await loadClient(
    t, streamDoc('application/json-seq', { type: 'number' }),
    'Streams',
    { mobx: false, validation: false },
  );
  const numbers = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse(
      'application/json-seq',
      [new TextEncoder().encode(`${RS}1\n${RS}true\n${RS}null\n`)],
    ),
  });
  const numberStream = (await numbers.readStream().execute({})).body;
  if (!isAsyncIterable(numberStream)) throw new TypeError('number stream');
  const values: unknown[] = [];
  for await (const item of numberStream) values.push(item);
  assert.deepEqual(values, [1, true, null]);

  const emptyClient = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse('application/json-seq', []),
  });
  const empty = (await emptyClient.readStream().execute({})).body;
  if (!isAsyncIterable(empty)) throw new TypeError('empty stream');
  const emptyItems: unknown[] = [];
  for await (const item of empty) emptyItems.push(item);
  assert.deepEqual(emptyItems, []);

  const SseClient = await loadClient(
    t, streamDoc('text/event-stream', {
      type: 'object',
      required: ['data'],
      properties: { data: { type: 'string' }, event: { type: 'string' } },
    }),
    'Streams',
    { mobx: false, validation: false },
  );
  const sseClient = new SseClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse(
      'text/event-stream',
      [new TextEncoder().encode('event: ping\ndata: {"id":1}\n\n')],
    ),
  });
  const sse = (await sseClient.readStream().execute({})).body;
  if (!isAsyncIterable(sse)) throw new TypeError('sse stream');
  const events: unknown[] = [];
  for await (const item of sse) events.push(item);
  assert.deepEqual(events, [{ data: '{"id":1}', event: 'ping' }]);
});

test('itemSchema false emits AsyncIterable<never>; validation-on rejects the first item and validation-off still yields', async (t) => {
  const document = streamDoc('application/x-ndjson', false);
  const typesOff = await generateMaterializedSdk(document, {
    output: path.join(createFixtureProject(t, 'runic-openapi-itemschema-'), 'sdk'),
    name: 'NeverStream',
    profile: { mobx: false, validation: false },
  });
  const types = typesOff.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
  assert.match(types, /AsyncIterable<never>/);

  const OffClient = await loadClient(t, document, 'NeverStream', { mobx: false, validation: false });
  const off = new OffClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse(
      'application/x-ndjson',
      [new TextEncoder().encode('{"id":1}\n')],
    ),
  });
  const offStream = (await off.readStream().execute({})).body;
  if (!isAsyncIterable(offStream)) throw new TypeError('off stream');
  const yielded: unknown[] = [];
  for await (const item of offStream) yielded.push(item);
  assert.deepEqual(yielded, [{ id: 1 }]);

  const OnClient = await loadClient(t, document, 'NeverStream', { mobx: false, validation: true });
  const on = new OnClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => streamResponse(
      'application/x-ndjson',
      [new TextEncoder().encode('{"id":1}\n')],
    ),
  });
  const onStream = (await on.readStream().execute({})).body;
  if (!isAsyncIterable(onStream)) throw new TypeError('on stream');
  await assert.rejects(async () => {
    for await (const item of onStream) assert.equal(item, undefined);
  }, /validation failed/);
});

test('itemSchema is rejected for OpenAPI 3.1 before SDK generation', async () => {
  assert.throws(
    () => normalizeDocument({ ...streamDoc('application/x-ndjson', false), openapi: '3.1.0' }),
    /itemSchema is only supported in OpenAPI 3\.2/,
  );
});

test('breaking a live stream cancels and releases the reader', async (t) => {
  for (const profile of [
    { mobx: false, validation: false },
    { mobx: true, validation: true },
  ]) {
    const Client = await loadClient(
      t, streamDoc('application/x-ndjson', objectItem),
      'Streams',
      profile,
    );
    let cancelled = false;
    const sourceRef: { current?: ReadableStream<Uint8Array> } = {};
    const client = new Client({
      baseUrl: 'https://api.example',
      fetchImpl: async () => hangingResponse(
        'application/x-ndjson',
        new TextEncoder().encode('{"id":1}\n'),
        () => {
          cancelled = true;
        },
        stream => { sourceRef.current = stream; },
      ),
    });
    const stream = (await client.readStream().execute({})).body;
    if (!isAsyncIterable(stream)) throw new TypeError('cancel stream');
    const iterator = stream[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: { id: 1 }, done: false });
    await iterator.return?.();
    assert.equal(cancelled, true, `profile ${JSON.stringify(profile)} cancels the source on early return`);
    assert.equal(streamLocked(sourceRef), false, `profile ${JSON.stringify(profile)} releases the reader lock on early return`);
  }
});

test('validation-disabled generated clients preserve stream cancellation and report missing media codecs', async (t: TestContext) => {
  const output = createFixtureProject(t, 'runic-openapi-media-codecs-');

  const document = {
    openapi: '3.2.0',
    info: { title: 'Media QA', version: '1' },
    paths: {
      '/upload': {
        post: {
          operationId: 'upload',
          requestBody: {
            required: true,
            content: {
              'application/xml': {
                schema: { type: 'object', properties: { value: { type: 'string' } } },
              },
            },
          },
          responses: { 204: { description: 'uploaded' } },
        },
      },
    },
  };
  writeGeneratedSdk(writeSdk, document, {
    output,
    name: 'MediaQa',
    profile: { mobx: false, validation: false },
  });
  compileGeneratedSdk(output);
  interface MediaQaExport {
    MediaQaClient: new (options: {
      baseUrl: string;
      fetchImpl?: (url: string, init?: unknown) => Promise<Response>;
    }) => {
      upload: () => { execute: (args: { body: { value: string } }) => Promise<unknown> };
    };
  }
  const { MediaQaClient } = await import(pathToFileURL(path.join(output, 'dist/client.js')).href) as MediaQaExport;

  let uploadCalled = false;
  const missingEncoderClient = new MediaQaClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => {
      uploadCalled = true;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    () => missingEncoderClient.upload().execute({ body: { value: 'encoded' } }),
    /No request body encoder configured/,
  );
  assert.equal(uploadCalled, false);
});
