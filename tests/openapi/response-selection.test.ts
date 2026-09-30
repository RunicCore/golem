import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
} from './helpers.js';

function document(): Record<string, unknown> {
  return {
    openapi: '3.2.0',
    info: { title: 'Select', version: '1' },
    paths: {
            '/exact': {
        get: {
          operationId: 'getExact',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { type: 'object', properties: { kind: { const: 'exact' } } } },
              },
            },
            '2XX': {
              description: 'range',
              content: {
                'application/json': { schema: { type: 'object', properties: { kind: { const: 'range' } } } },
              },
            },
          },
        },
      },
      '/item': {
        get: {
          operationId: 'getItem',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { type: 'object', properties: { kind: { const: 'exact' } } } },
                'application/*': { schema: { type: 'object', properties: { kind: { const: 'type' } } } },
                '*/*': { schema: { type: 'object', properties: { kind: { const: 'star' } } } },
              },
            },
            '2XX': {
              description: 'range',
              content: {
                'application/json': { schema: { type: 'object', properties: { kind: { const: 'range' } } } },
              },
            },
            default: {
              description: 'fallback',
              content: {
                'application/json': { schema: { type: 'object', properties: { kind: { const: 'default' } } } },
              },
            },
          },
        },
      },
    },
  };
}

// One generate and compile: the emitted response contract does not depend on mobx or validation, so every test shares it.
let selectClient: ReturnType<typeof generateClient> | undefined;
const selectRoots: string[] = [];
after(() => {
  for (const root of selectRoots) fs.rmSync(root, { recursive: true, force: true });
});

function loadClient() {
  selectClient ??= generateClient();
  return selectClient;
}

async function generateClient() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-openapi-select-')));
  selectRoots.push(root);
  const output = path.join(root, 'sdk');
  await generateMaterializedSdk(document(), { output, name: 'Select', profile: { mobx: false, validation: false } });
  compileGeneratedSdk(output);
  const module = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    'select client',
  );
  assert.equal(isGeneratedClientClass(module.SelectClient), true);
  if (!isGeneratedClientClass(module.SelectClient)) throw new TypeError('SelectClient');
  return module.SelectClient;
}

function json(status: number, body: unknown, contentType: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

test('selects exact status then exact media, then type/*, then */* without status fallthrough', async () => {
  const SelectClient = await loadClient();
  const seen: string[] = [];
  const client = new SelectClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => {
      const next = seen.length;
      if (next === 0) return json(200, { kind: 'exact' }, 'Application/JSON');
      if (next === 1) return json(200, { kind: 'type' }, 'application/problem+json');
      if (next === 2) return json(200, { kind: 'star' }, 'text/json');
      if (next === 3) return json(201, { kind: 'range' }, 'application/json');
      if (next === 4) return json(404, { kind: 'default' }, 'application/json');
      return json(200, { kind: 'wrong' }, 'image/png');
    },
  });

  const exact = await client.getItem().execute({});
  seen.push('exact');
  assert.equal(exact.status, 200);
  assert.equal(exact.contentType, 'application/json');
  assert.deepEqual(exact.body, { kind: 'exact' });

  const typeRange = await client.getItem().execute({});
  seen.push('type');
  assert.equal(typeRange.contentType, 'application/*');
  assert.deepEqual(typeRange.body, { kind: 'type' });

  const star = await client.getItem().execute({});
  seen.push('star');
  assert.equal(star.contentType, '*/*');
  assert.deepEqual(star.body, { kind: 'star' });

  const range = await client.getItem().execute({});
  seen.push('range');
  assert.equal(range.status, 201);
  assert.equal(range.contentType, 'application/json');
  assert.deepEqual(range.body, { kind: 'range' });

  const fallback = await client.getItem().execute({});
  seen.push('default');
  assert.equal(fallback.status, 404);
  assert.deepEqual(fallback.body, { kind: 'default' });

  // The selected status 200 declares only JSON: a wrong media type is undeclared, not another status's response.
  const wrongMedia = new SelectClient({
    baseUrl: 'https://api.example',
    fetchImpl: async () => json(200, { kind: 'wrong' }, 'text/plain'),
  });
  await assert.rejects(
    () => wrongMedia.getExact().execute({}),
    /Undeclared OpenAPI response.*200/,
  );
});

test('custom response decoder overrides built-in JSON and protocol checks remain', async () => {
  const SelectClient = await loadClient();
  const responseDecoders = {
    'application/json': async (response: Response) => {
      const text = await response.text();
      return { ...JSON.parse(text), custom: true };
    },
  };
  const client = new SelectClient({
    baseUrl: 'https://api.example',
    responseDecoders,
    fetchImpl: async () => json(200, { kind: 'exact' }, 'application/json'),
  });
  const result = await client.getItem().execute({});
  assert.deepEqual(result.body, { kind: 'exact', custom: true });

  const undeclaredClient = new SelectClient({
    baseUrl: 'https://api.example',
    responseDecoders,
    fetchImpl: async () => json(200, { kind: 'wrong' }, 'text/plain'),
  });
  await assert.rejects(
    () => undeclaredClient.getExact().execute({}),
    /Undeclared OpenAPI response.*200/,
    'an installed custom decoder does not bypass the undeclared-media check',
  );
});
