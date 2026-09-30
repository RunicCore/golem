import type { TestContext } from 'node:test';
import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { normalizeDocument } from '#openapi/generator';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isAsyncIterable,
  isGeneratedClientClass,
  requireRecord,
  type GeneratedClientClass,
} from './helpers.js';

const RS = '\u001e';

function streamResponse(contentType: string, chunks: readonly Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

async function loadClientAt(
  output: string,
  document: unknown,
  name: string,
  profile: { mobx: boolean; validation: boolean; ajvStandalone?: boolean },
): Promise<GeneratedClientClass> {
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

function loadClient(
  t: TestContext,
  document: unknown,
  name: string,
  profile: { mobx: boolean; validation: boolean; ajvStandalone?: boolean },
): Promise<GeneratedClientClass> {
  return loadClientAt(path.join(createFixtureProject(t, 'runic-openapi-streams-'), 'sdk'), document, name, profile);
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

// One generate and compile serves both tests: an itemSchema:false stream and an operation whose request media type has no encoder.
let neverStreamClient: Promise<GeneratedClientClass> | undefined;
const neverStreamRoots: string[] = [];
after(() => {
  for (const root of neverStreamRoots) fs.rmSync(root, { recursive: true, force: true });
});

function loadNeverStreamClient(): Promise<GeneratedClientClass> {
  if (neverStreamClient) return neverStreamClient;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runic-openapi-never-stream-')));
  neverStreamRoots.push(root);
  const streams = streamDoc('application/x-ndjson', false);
  const document = {
    ...streams,
    paths: {
      ...(streams.paths as Record<string, unknown>),
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
  neverStreamClient = loadClientAt(path.join(root, 'sdk'), document, 'NeverStream', { mobx: false, validation: true });
  return neverStreamClient;
}

test('itemSchema false emits AsyncIterable<never> and validation-on rejects the first item', async (t) => {
  const typesOff = await generateMaterializedSdk(streamDoc('application/x-ndjson', false), {
    output: path.join(createFixtureProject(t, 'runic-openapi-itemschema-'), 'sdk'),
    name: 'NeverStream',
    profile: { mobx: false, validation: false },
  });
  const types = typesOff.artifacts.find((artifact) => artifact.path.endsWith('/types.ts'))?.content ?? '';
  assert.match(types, /AsyncIterable<never>/);

  const OnClient = await loadNeverStreamClient();
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


test('a request media type without a configured encoder rejects before any request is sent', async () => {
  const Client = await loadNeverStreamClient();
  let uploadCalled = false;
  const client = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => {
      uploadCalled = true;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    () => client.upload().execute({ body: { value: 'encoded' } }),
    /No request body encoder configured/,
  );
  assert.equal(uploadCalled, false);
});
