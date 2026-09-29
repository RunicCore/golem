import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { clientConsumerSource } from '../fixture-templates/openapi/client-consumer.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import { generate } from '#openapi/generator';
import {
  captureRequest,
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
  ALL_GENERATION_PROFILES,
  documentBase,
  materializeGeneratedSdk,
  writeOpenApiDocument,
  type GeneratedClientClass,
  type OpenApiGenerationProfile,
} from './helpers.js';

const okEmpty = { 204: { description: 'ok' } };

function contractDocument(): Record<string, unknown> {
  const headerContract = Object.fromEntries([
    ['X-Flags', { schema: { type: 'array', items: { type: 'boolean' } } }],
    ['X-Exploded', {
      explode: true,
      schema: {
        type: 'object',
        properties: { count: { type: 'integer' }, active: { type: 'boolean' } },
      },
    }],
    ['X-Object', {
      explode: false,
      schema: {
        type: 'object',
        properties: { count: { type: 'integer' }, active: { type: 'boolean' } },
      },
    }],
    ['X-Note', { schema: { type: 'string' } }],
    ['__proto__', { schema: { type: 'string' } }],
  ]);
  return {
    openapi: '3.1.0',
    info: { title: 'Client contracts', version: '1' },
    components: {
      schemas: {
        Count: { type: 'number' },
        Note: { type: 'string' },
      },
      securitySchemes: {
        toString: { type: 'http', scheme: 'bearer' },
        constructor: { type: 'apiKey', in: 'header', name: 'X-Ctor' },
        bearer: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Key' },
      },
    },
    paths: {
      '/selected-codec': {
        get: {
          operationId: 'selectTextCodec',
          responses: {
            200: {
              description: 'success',
              content: {
                'application/json': { schema: { type: 'number' } },
                'text/plain': { schema: { type: 'number' } },
              },
            },
            400: {
              description: 'message',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/auth/to-string': {
        get: {
          operationId: 'useToString',
          security: [{ toString: ['read'] }],
          responses: okEmpty,
        },
      },
      '/auth/constructor': {
        get: {
          operationId: 'useConstructor',
          security: [{ constructor: [] }],
          responses: okEmpty,
        },
      },
      '/auth/or': {
        get: {
          operationId: 'useOr',
          security: [{ toString: [] }, { bearer: [] }],
          responses: okEmpty,
        },
      },
      '/auth/and': {
        get: {
          operationId: 'useAnd',
          security: [{ bearer: [], apiKey: [] }],
          responses: okEmpty,
        },
      },
      '/json-upper': {
        post: {
          operationId: 'sendJsonUpper',
          requestBody: {
            required: true,
            content: { 'Application/JSON': { schema: { type: 'object', additionalProperties: true } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'Application/JSON': { schema: { type: 'object', additionalProperties: true } } },
            },
          },
        },
      },
      '/json-param': {
        post: {
          operationId: 'sendJsonParam',
          requestBody: {
            required: true,
            content: {
              'application/json; charset=utf-8': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json; charset=utf-8': {
                  schema: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
      '/form-upper': {
        post: {
          operationId: 'sendFormUpper',
          requestBody: {
            required: true,
            content: {
              'APPLICATION/X-WWW-FORM-URLENCODED': {
                schema: {
                  type: 'object',
                  properties: { amount: { type: 'integer' } },
                },
              },
            },
          },
          responses: okEmpty,
        },
      },
      '/form-param': {
        post: {
          operationId: 'sendFormParam',
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded; charset=UTF-8': {
                schema: {
                  type: 'object',
                  properties: { amount: { type: 'integer' } },
                },
              },
            },
          },
          responses: okEmpty,
        },
      },
      '/multipart-upper': {
        post: {
          operationId: 'sendMultipartUpper',
          requestBody: {
            required: true,
            content: {
              'Multipart/Form-Data': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                },
              },
            },
          },
          responses: okEmpty,
        },
      },
      '/custom': {
        post: {
          operationId: 'sendCustom',
          requestBody: {
            required: true,
            content: { 'application/vnd.example.raw': { schema: { type: 'string' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/vnd.example.raw': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/text-string': {
        post: {
          operationId: 'sendTextString',
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/text-unknown': {
        post: {
          operationId: 'sendTextUnknown',
          requestBody: {
            required: true,
            content: { 'text/plain': {} },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': {} },
            },
          },
        },
      },
      '/text-number': {
        post: {
          operationId: 'sendTextNumber',
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { type: 'number' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': { schema: { type: 'number' } } },
            },
          },
        },
      },
      '/text-ref': {
        post: {
          operationId: 'sendTextRef',
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { $ref: '#/components/schemas/Count' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': { schema: { $ref: '#/components/schemas/Count' } } },
            },
          },
        },
      },
      '/text-allof': {
        post: {
          operationId: 'sendTextAllOf',
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { allOf: [{ type: 'number' }] } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': { schema: { allOf: [{ type: 'number' }] } } },
            },
          },
        },
      },
      '/text-oneof': {
        post: {
          operationId: 'sendTextOneOf',
          requestBody: {
            required: true,
            content: {
              'text/plain': {
                schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: {
                'text/plain': {
                  schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                },
              },
            },
          },
        },
      },
      '/text-repeated-refs': {
        post: {
          operationId: 'sendTextRepeatedRefs',
          requestBody: {
            required: true,
            content: {
              'text/plain': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/Note' },
                    { $ref: '#/components/schemas/Note' },
                  ],
                  anyOf: [
                    { $ref: '#/components/schemas/Note' },
                    { $ref: '#/components/schemas/Note' },
                  ],
                },
              },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: {
                'text/plain': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/Note' },
                      { $ref: '#/components/schemas/Note' },
                    ],
                    anyOf: [
                      { $ref: '#/components/schemas/Note' },
                      { $ref: '#/components/schemas/Note' },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/text-nullable': {
        post: {
          operationId: 'sendTextNullableString',
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { type: ['string', 'null'] } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': { schema: { type: ['string', 'null'] } } },
            },
          },
        },
      },
      '/text-nullable-union': {
        post: {
          operationId: 'sendTextNullableUnion',
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': { schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
            },
          },
        },
      },
      '/text-enum-null': {
        post: {
          operationId: 'sendTextEnumNull',
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { enum: ['x', null] } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': { schema: { enum: ['x', null] } } },
            },
          },
        },
      },
      '/text-null': {
        post: {
          operationId: 'sendTextNull',
          requestBody: {
            required: true,
            content: { 'text/plain': { schema: { type: 'null' } } },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'text/plain': { schema: { type: 'null' } } },
            },
          },
        },
      },
      '/headers': {
        get: {
          operationId: 'readHeaders',
          responses: {
            200: {
              description: 'ok',
              headers: headerContract,
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
}

async function loadContractClient(
  t: TestContext,
  name: string,
  profile: OpenApiGenerationProfile,
): Promise<GeneratedClientClass> {
  const root = createFixtureProject(t, 'runic-openapi-client-contracts-');
  const output = path.join(root, 'sdk');
  await generateMaterializedSdk(contractDocument(), { output, name, profile });
  const consumer = path.join(output, 'consumer.ts');
  writeFileSync(consumer, clientConsumerSource({ name }).text);
  compileGeneratedSdk(output, [consumer]);
  const module = requireRecord(
    await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
    `${name} client`,
  );
  const Client = module[`${name}Client`];
  assert.equal(isGeneratedClientClass(Client), true);
  if (!isGeneratedClientClass(Client)) throw new TypeError(`${name}Client`);
  return Client;
}

function jsonResponse(body: unknown, contentType: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

test('own configured auth keys are required before providers run, including special names', async (t) => {
  const Client = await loadContractClient(t, 'ContractAuth', { mobx: false, validation: false });
  const inherited = Object.create({
    toString() {
      return 'inherited-token';
    },
    constructor() {
      return 'inherited-ctor';
    },
  });
  let fetchCount = 0;
  const missing = new Client({
    baseUrl: 'https://api.example',
    auth: inherited,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(null, { status: 204 });
    },
  });
  const pending = missing.useToString();
  assert.equal(fetchCount, 0, 'factory stays lazy');
  await assert.rejects(() => pending.execute({}), /No configured credentials satisfy/);
  await assert.rejects(() => missing.useConstructor().execute({}), /No configured credentials satisfy/);
  assert.equal(fetchCount, 0, 'inherited toString and constructor must not become credentials');

  const scopes: unknown[] = [];
  const requests: string[] = [];
  const own = new Client({
    baseUrl: 'https://api.example',
    auth: {
      toString: async (context: { scheme: string; scopes: readonly string[] }) => {
        scopes.push({ scheme: context.scheme, scopes: [...context.scopes] });
        return 'own-async';
      },
      constructor: 'ctor-key',
      bearer: 'bearer-token',
      apiKey: 'and-key',
    },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const captured = captureRequest(url, init);
      requests.push([
        new URL(captured.url).pathname,
        captured.init.headers.get('authorization'),
        captured.init.headers.get('X-Ctor'),
        captured.init.headers.get('X-Key'),
      ].join('|'));
      return new Response(null, { status: 204 });
    },
  });
  await own.useToString().execute({});
  await own.useConstructor().execute({});
  await own.useOr().execute({});
  await own.useAnd().execute({});
  assert.deepEqual(scopes, [
    { scheme: 'toString', scopes: ['read'] },
    { scheme: 'toString', scopes: [] },
  ]);
  assert.deepEqual(requests, [
    '/auth/to-string|Bearer own-async||',
    '/auth/constructor||ctor-key|',
    '/auth/or|Bearer own-async||',
    '/auth/and|Bearer bearer-token||and-key',
  ]);

  const fallback = new Client({
    baseUrl: 'https://api.example',
    auth: { bearer: 'or-token' },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(captureRequest(url, init).init.headers.get('authorization'), 'Bearer or-token');
      return new Response(null, { status: 204 });
    },
  });
  await fallback.useOr().execute({});
  await assert.rejects(() => fallback.useAnd().execute({}), /No configured credentials satisfy/);
  await assert.rejects(() => fallback.useToString().execute({}), /No configured credentials satisfy/);

  const undefinedOwn = new Client({
    baseUrl: 'https://api.example',
    auth: { toString: undefined, bearer: 'or-token' },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(captureRequest(url, init).init.headers.get('authorization'), 'Bearer or-token');
      return new Response(null, { status: 204 });
    },
  });
  await undefinedOwn.useOr().execute({});
  await assert.rejects(() => undefinedOwn.useToString().execute({}), /No configured credentials satisfy/);
});

test('media essence selects builtins and custom codecs without depending on insertion order', async (t) => {
  const Client = await loadContractClient(t, 'ContractMedia', { mobx: false, validation: false });
  const captured: Array<{ path: string; contentType: string | null; body: string | null; form: boolean }> = [];
  const builtin = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const request = captureRequest(url, init);
      const body = request.init.body;
      captured.push({
        path: new URL(request.url).pathname,
        contentType: request.init.headers.get('content-type'),
        body: typeof body === 'string' ? body : body instanceof FormData ? null : body == null ? null : String(body),
        form: body instanceof FormData,
      });
      if (new URL(request.url).pathname.startsWith('/json')) {
        return jsonResponse({ ok: true }, request.init.headers.get('content-type') || 'application/json');
      }
      return new Response(null, { status: 204 });
    },
  });
  const json = await builtin.sendJsonUpper().execute({ body: { ok: true } });
  assert.deepEqual(json.body, { ok: true });
  await builtin.sendJsonParam().execute({ body: { ok: true } });
  await builtin.sendFormUpper().execute({ body: { amount: 25 } });
  await builtin.sendFormParam().execute({ body: { amount: 7 } });
  await builtin.sendMultipartUpper().execute({ body: { name: 'Ada' } });
  assert.deepEqual(captured.map((item) => item.path), [
    '/json-upper',
    '/json-param',
    '/form-upper',
    '/form-param',
    '/multipart-upper',
  ]);
  assert.equal(captured[0]?.contentType, 'Application/JSON');
  assert.equal(captured[0]?.body, '{"ok":true}');
  assert.equal(captured[1]?.contentType, 'application/json; charset=utf-8');
  assert.equal(captured[1]?.body, '{"ok":true}');
  assert.equal(captured[2]?.contentType, 'APPLICATION/X-WWW-FORM-URLENCODED');
  assert.equal(captured[2]?.body, 'amount=25');
  assert.equal(captured[3]?.contentType, 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(captured[3]?.body, 'amount=7');
  assert.equal(captured[4]?.form, true);
  assert.equal(captured[4]?.contentType, null);

  const sources: string[] = [];
  const custom = new Client({
    baseUrl: 'https://api.example',
    bodyEncoders: {
      '*/*': () => {
        sources.push('wild-enc');
        return 'wild';
      },
      'application/json': () => {
        sources.push('essence-enc');
        return 'essence';
      },
      'Application/JSON': () => {
        sources.push('raw-enc');
        return 'raw';
      },
    },
    responseDecoders: {
      '*/*': async () => {
        sources.push('wild-dec');
        return { source: 'wild' };
      },
      'application/json': async () => {
        sources.push('essence-dec');
        return { source: 'essence' };
      },
      'Application/JSON': async () => {
        sources.push('raw-dec');
        return { source: 'raw' };
      },
    },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const request = captureRequest(url, init);
      return jsonResponse({ ignored: true }, request.init.headers.get('content-type') || 'application/json');
    },
  });
  const raw = await custom.sendJsonUpper().execute({ body: { ok: true } });
  const essence = await custom.sendJsonParam().execute({ body: { ok: true } });
  assert.deepEqual(raw.body, { source: 'raw' });
  assert.deepEqual(essence.body, { source: 'essence' });
  assert.deepEqual(sources, ['raw-enc', 'raw-dec', 'essence-enc', 'essence-dec']);

  const reversedSources: string[] = [];
  const reversed = new Client({
    baseUrl: 'https://api.example',
    bodyEncoders: {
      'Application/JSON': () => {
        reversedSources.push('raw-enc');
        return 'raw';
      },
      'application/json': () => {
        reversedSources.push('essence-enc');
        return 'essence';
      },
      '*/*': () => {
        reversedSources.push('wild-enc');
        return 'wild';
      },
    },
    responseDecoders: {
      'Application/JSON': async () => {
        reversedSources.push('raw-dec');
        return { source: 'raw' };
      },
      'application/json': async () => {
        reversedSources.push('essence-dec');
        return { source: 'essence' };
      },
      '*/*': async () => {
        reversedSources.push('wild-dec');
        return { source: 'wild' };
      },
    },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const request = captureRequest(url, init);
      return jsonResponse({ ignored: true }, request.init.headers.get('content-type') || 'application/json');
    },
  });
  const reversedRaw = await reversed.sendJsonUpper().execute({ body: { ok: true } });
  const reversedEssence = await reversed.sendJsonParam().execute({ body: { ok: true } });
  assert.deepEqual(reversedRaw.body, { source: 'raw' });
  assert.deepEqual(reversedEssence.body, { source: 'essence' });
  assert.deepEqual(reversedSources, ['raw-enc', 'raw-dec', 'essence-enc', 'essence-dec']);

  const wild = new Client({
    baseUrl: 'https://api.example',
    bodyEncoders: {
      '*/*': (value: unknown) => `wild:${String(value)}`,
    },
    responseDecoders: {
      '*/*': async (response: Response) => `decoded:${await response.text()}`,
    },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const request = captureRequest(url, init);
      assert.equal(request.init.body, 'wild:payload');
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'application/vnd.example.raw' },
      });
    },
  });
  const customBody = await wild.sendCustom().execute({ body: 'payload' });
  assert.equal(customBody.body, 'decoded:ok');
});

test('non-string text schemas require selected-path codecs for every validation profile', async (t) => {
  for (const validation of [false, true]) {
    const Client = await loadContractClient(t, `ContractText${validation ? 'On' : 'Off'}`, {
      mobx: false,
      validation,
    });
    let fetchCount = 0;
    const missing = new Client({
      baseUrl: 'https://api.example',
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response('12', { status: 200, headers: { 'content-type': 'text/plain' } });
      },
    });
    const lazy = missing.sendTextNumber();
    assert.equal(fetchCount, 0);
    await assert.rejects(
      () => lazy.execute({ body: 12 }),
      /Custom bodyEncoders required for operation sendTextNumber media text\/plain type number/,
    );
    assert.equal(fetchCount, 0, 'missing request codec fails before fetch');

    let cancelled = false;
    const missingResponse = new Client({
      baseUrl: 'https://api.example',
      bodyEncoders: {
        'text/plain': (value: unknown) => String(value),
      },
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('12'));
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    await assert.rejects(
      () => missingResponse.sendTextNumber().execute({ body: 12 }),
      /Custom responseDecoders required for operation sendTextNumber status 200 media text\/plain type number/,
    );
    assert.equal(cancelled, true);

    for (const operation of ['sendTextRef', 'sendTextAllOf', 'sendTextOneOf'] as const) {
      await assert.rejects(
        () => missing[operation]().execute({ body: operation === 'sendTextOneOf' ? 'x' : 1 }),
        /Custom bodyEncoders required/,
      );
    }

    await assert.rejects(
      () => missing.sendTextNullableString().execute({ body: null }),
      /Custom bodyEncoders required for operation sendTextNullableString media text\/plain type string \| null/,
    );
    await assert.rejects(
      () => missing.sendTextNullableString().execute({ body: 'hello' }),
      /Custom bodyEncoders required for operation sendTextNullableString media text\/plain type string \| null/,
    );
    await assert.rejects(
      () => missing.sendTextNullableUnion().execute({ body: null }),
      /Custom bodyEncoders required for operation sendTextNullableUnion media text\/plain type \(string\) \| \(null\)/,
    );
    await assert.rejects(
      () => missing.sendTextEnumNull().execute({ body: null }),
      /Custom bodyEncoders required for operation sendTextEnumNull media text\/plain type "x" \| null/,
    );
    await assert.rejects(
      () => missing.sendTextNull().execute({ body: null }),
      /Custom bodyEncoders required for operation sendTextNull media text\/plain type null/,
    );
    assert.equal(fetchCount, 0, 'null and nullable text fail before fetch');

    const missingNullableResponse = new Client({
      baseUrl: 'https://api.example',
      bodyEncoders: {
        'text/plain': (value: unknown) => (value === null ? 'null' : String(value)),
      },
      fetchImpl: async () => new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    });
    await assert.rejects(
      () => missingNullableResponse.sendTextNullableString().execute({ body: null }),
      /Custom responseDecoders required for operation sendTextNullableString status 200 media text\/plain type string \| null/,
    );

    const provided = new Client({
      baseUrl: 'https://api.example',
      bodyEncoders: {
        'text/plain': (value: unknown) => {
          if (value === null) return 'null';
          if (value === 'x' || value === 'hello') return String(value);
          if (typeof value !== 'number') throw new TypeError('expected number text');
          return String(value);
        },
      },
      responseDecoders: {
        'text/plain': async (response: Response) => {
          const text = await response.text();
          if (text === 'null') return null;
          if (text === 'x' || text === 'hello') return text;
          const parsed = Number(text);
          if (!Number.isFinite(parsed)) throw new TypeError('expected number text');
          return parsed;
        },
      },
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const request = captureRequest(url, init);
        return new Response(String(request.init.body), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      },
    });
    const counted = await provided.sendTextNumber().execute({ body: 12 });
    assert.equal(counted.body, 12);
    const referenced = await provided.sendTextRef().execute({ body: 3 });
    assert.equal(referenced.body, 3);
    const composed = await provided.sendTextAllOf().execute({ body: 4 });
    assert.equal(composed.body, 4);
    const ambiguous = await provided.sendTextOneOf().execute({ body: 'x' });
    assert.equal(ambiguous.body, 'x');
    const nullable = await provided.sendTextNullableString().execute({ body: null });
    assert.equal(nullable.body, null);
    const nullableString = await provided.sendTextNullableUnion().execute({ body: 'hello' });
    assert.equal(nullableString.body, 'hello');
    const enumerated = await provided.sendTextEnumNull().execute({ body: null });
    assert.equal(enumerated.body, null);
    const onlyNull = await provided.sendTextNull().execute({ body: null });
    assert.equal(onlyNull.body, null);

    const strings = new Client({
      baseUrl: 'https://api.example',
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const request = captureRequest(url, init);
        assert.equal(request.init.body, 'hello');
        return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
      },
    });
    const typed = await strings.sendTextString().execute({ body: 'hello' });
    assert.equal(typed.body, 'hello');
    const unknown = await strings.sendTextUnknown().execute({ body: 'hello' });
    assert.equal(unknown.body, 'hello');
    const repeatedRefs = await strings.sendTextRepeatedRefs().execute({ body: 'hello' });
    assert.equal(repeatedRefs.body, 'hello');

    // Only the selected status/media needs a decoder, even within one operation.
    let selectedStatus = 200;
    let selectedMedia = 'application/json';
    const selective = new Client({
      baseUrl: 'https://api.example',
      fetchImpl: async () => new Response(selectedStatus === 400 ? 'try again' : '12', {
        status: selectedStatus, headers: { 'content-type': selectedMedia },
      }),
    });
    assert.equal((await selective.selectTextCodec().execute({})).body, 12);
    selectedStatus = 400;
    selectedMedia = 'text/plain';
    assert.equal((await selective.selectTextCodec().execute({})).body, 'try again');
    selectedStatus = 200;
    await assert.rejects(() => selective.selectTextCodec().execute({}),
      /Custom responseDecoders required for operation selectTextCodec status 200 media text\/plain type number/);

    if (validation) {
      const wrongShape = new Client({
        baseUrl: 'https://api.example',
        responseDecoders: { 'text/plain': async () => 'wrong shape' },
        fetchImpl: async () => new Response('12', { headers: { 'content-type': 'text/plain' } }),
      });
      await assert.rejects(() => wrongShape.selectTextCodec().execute({}),
        (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation);
    }
  }
});

test('response header decoding strips only SP/HTAB around list tokens and keeps own __proto__', async (t) => {
  const Client = await loadContractClient(t, 'ContractHeaders', { mobx: false, validation: false });
  const client = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: new Headers([
        ['content-type', 'application/json'],
        ['X-Flags', 'true, \tfalse'],
        ['X-Exploded', 'count=3, \tactive=\ttrue'],
        ['X-Object', 'count, \t3, active, \ttrue'],
        ['X-Note', 'hello, \t world'],
        ['__proto__', 'wire'],
      ]),
    }),
  });
  const result = await client.readHeaders().execute({});
  assert.deepEqual(result.headers?.['X-Flags'], [true, false]);
  assert.deepEqual(result.headers?.['X-Exploded'], { count: 3, active: true });
  assert.deepEqual(result.headers?.['X-Object'], { count: 3, active: true });
  assert.equal(result.headers?.['X-Note'], 'hello, \t world');
  assert.equal(Object.getPrototypeOf(result.headers), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(result.headers, '__proto__'), true);
  assert.equal(Object.getOwnPropertyDescriptor(result.headers, '__proto__')?.value, 'wire');

  const nbsp = new Client({
    baseUrl: 'https://api.example',
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: new Headers([
        ['content-type', 'application/json'],
        ['X-Flags', `true,\u00a0false`],
      ]),
    }),
  });
  await assert.rejects(() => nbsp.readHeaders().execute({}), /Invalid boolean response header/);
});

test('unsupported HTTP Digest authentication fails generation without Bearer fallback', async (t) => {
  const directory = createFixtureProject(t, 'runic-openapi-r15-');
  const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
    paths: {
      '/secure': {
        get: {
          operationId: 'secure',
          security: [{ digest: [] }, { apiKey: [] }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
    components: {
      securitySchemes: {
        digest: { type: 'http', scheme: 'Digest' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Key' },
        bearer: { type: 'http', scheme: 'bearer' },
      },
    },
  }));
  await assert.rejects(
    () => generate({ input, output: path.join(directory, 'sdk'), profile: { mobx: false, validation: false } }),
    /unsupported HTTP authentication scheme "Digest"/,
  );
});

test('XML object responses require runtime decoders in every profile, including PDF/ZIP blobs', async (t) => {
  for (const profile of ALL_GENERATION_PROFILES) {
    const directory = createFixtureProject(t, 'runic-openapi-r16-');
    const input = writeOpenApiDocument(directory, documentBase('3.1.0', {
      paths: {
        '/xml': {
          get: {
            operationId: 'getXml',
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/xml': {
                    schema: {
                      type: 'object',
                      required: ['value'],
                      properties: { value: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        '/pdf': {
          get: {
            operationId: 'getPdf',
            responses: {
              200: {
                description: 'file',
                content: { 'application/pdf': {} },
              },
            },
          },
        },
        '/zip': {
          get: {
            operationId: 'getZip',
            responses: {
              200: {
                description: 'file',
                content: { 'application/zip': {} },
              },
            },
          },
        },
      },
    }));
    const result = await generate({
      input,
      output: path.join(directory, 'sdk'),
      name: 'MediaCodec',
      profile,
    });
    const output = path.join(directory, 'sdk');
    materializeGeneratedSdk(result.artifacts, output);
    compileGeneratedSdk(output);
    const compiled = requireRecord(
      await import(pathToFileURL(path.join(output, 'dist/client.js')).href),
      'MediaCodec client',
    );
    assert.equal(isGeneratedClientClass(compiled.MediaCodecClient), true);
    if (!isGeneratedClientClass(compiled.MediaCodecClient)) throw new TypeError('MediaCodecClient');
    const MediaCodecClient = compiled.MediaCodecClient;

    const missing = new MediaCodecClient({
      baseUrl: 'https://api.example',
      fetchImpl: async () => new Response('<value>raw</value>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      }),
    });
    await assert.rejects(() => missing.getXml().execute({}), /No response decoder configured/);

    const decoded = new MediaCodecClient({
      baseUrl: 'https://api.example',
      responseDecoders: {
        'application/xml': async (response: Response) => ({
          value: (await response.text()).replace(/^<value>|<\/value>$/g, ''),
        }),
      },
      fetchImpl: async (url: string) => {
        if (String(url).endsWith('/xml')) {
          return new Response('<value>decoded</value>', {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          });
        }
        if (String(url).endsWith('/pdf')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
        return new Response(new Uint8Array([4, 5]), {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      },
    });
    const xml = await decoded.getXml().execute({});
    assert.deepEqual(xml.body, { value: 'decoded' });
    const pdf = await decoded.getPdf().execute({});
    assert.ok(pdf.body instanceof Blob);
    assert.deepEqual([...new Uint8Array(await pdf.body.arrayBuffer())], [1, 2, 3]);
    const zip = await decoded.getZip().execute({});
    assert.ok(zip.body instanceof Blob);
    assert.deepEqual([...new Uint8Array(await zip.body.arrayBuffer())], [4, 5]);
  }
});
