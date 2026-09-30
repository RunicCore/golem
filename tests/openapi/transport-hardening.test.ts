import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { ClientRuntime } from '@exprtlabs/golem/client';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import {
  captureRequest,
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
  type CapturedRequest,
  type GeneratedClientClass,
} from './helpers.js';

const noContent = { 204: { description: 'done' } };

// The transport rules themselves (auth, query serialization, response bodies, SSE) are tested on
// ClientRuntime in tests/client-runtime-*.test.ts. This document only proves what the generator emits.
function transportDocument(): Record<string, unknown> {
  return {
    openapi: '3.2.0',
    info: { title: 'Transport', version: '1' },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        session: { type: 'apiKey', in: 'cookie', name: 'session' },
      },
    },
    paths: {
      '/optional-auth': { get: { operationId: 'optionalAuth', security: [{}, { bearer: [] }], responses: noContent } },
      '/session': { get: { operationId: 'sessionAuth', security: [{ session: [] }], responses: noContent } },
      '/reserved': {
        get: {
          operationId: 'reservedQuery',
          parameters: [
            { name: 'q', in: 'query', allowReserved: true, schema: { type: 'string' } },
            { name: 'this.id', in: 'query', schema: { type: 'string' } },
          ],
          responses: noContent,
        },
      },
      '/cookie': {
        get: {
          operationId: 'cookieParameter',
          parameters: [{ name: 'theme', in: 'cookie', schema: { type: 'string' } }],
          responses: noContent,
        },
      },
    },
  };
}

interface TransportSdk {
  readonly Client: GeneratedClientClass;
  readonly isUndeclared: (error: unknown) => boolean;
  readonly diagnostics: readonly { code: string }[];
}

// One generate and strict compile: mobx and validation do not touch transport, so both tests share it.
let transportSdk: Promise<TransportSdk> | undefined;
const transportRoots: string[] = [];
after(() => {
  for (const root of transportRoots) fs.rmSync(root, { recursive: true, force: true });
});

function loadTransportSdk(): Promise<TransportSdk> {
  transportSdk ??= generateTransportSdk();
  return transportSdk;
}

async function generateTransportSdk(): Promise<TransportSdk> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runic-openapi-transport-')));
  transportRoots.push(root);
  const output = path.join(root, 'sdk');
  const result = await generateMaterializedSdk(transportDocument(), {
    output,
    name: 'Transport',
    profile: { mobx: false, validation: false },
  });
  compileGeneratedSdk(output, [], { strict: true });
  const module = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'transport client');
  const Client = module.TransportClient;
  if (!isGeneratedClientClass(Client)) throw new TypeError('TransportClient must be a class');
  const guard = module.isTransportUndeclaredResponseError;
  if (typeof guard !== 'function') throw new TypeError('isTransportUndeclaredResponseError must be exported');
  const isUndeclared = (error: unknown): boolean => Reflect.apply(guard, undefined, [error]) === true;
  return { Client, isUndeclared, diagnostics: result.diagnostics ?? [] };
}

function recorder(respond: (request: CapturedRequest) => Response = () => new Response(null, { status: 204 })) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = captureRequest(input as string, init);
    requests.push(request);
    return respond(request);
  };
  return { requests, fetchImpl };
}

test('generated transport reports browser cookie diagnostics and wires reserved query characters and literal names', async () => {
  const { Client, diagnostics } = await loadTransportSdk();

  // Cookie parameters and cookie API keys cannot be sent from a browser.
  assert.deepEqual(
    diagnostics.map(diagnostic => diagnostic.code).sort(),
    ['OPENAPI_BROWSER_COOKIE', 'OPENAPI_BROWSER_COOKIE'],
  );

  // allowReserved keeps #[]&+ encoded and passes existing %XX triples through; names are literal.
  const calls = recorder();
  await new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl }).reservedQuery().execute({
    query: { q: 'a/b?c#d[e]&f+g%20h:@!$', 'this.id': 'x' },
  });
  assert.equal(calls.requests[0]?.url, 'https://api.test/reserved?q=a/b?c%23d%5Be%5D%26f%2Bg%20h:@!$&this.id=x');
});

test('generated transport sends the configured bearer token for an optional security requirement and no authorization header otherwise', async () => {
  const { Client } = await loadTransportSdk();

  // An optional requirement ({}) is a fallback: configured credentials are still sent.
  const calls = recorder();
  await new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl, auth: { bearer: 'token' } }).optionalAuth().execute({});
  await new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl }).optionalAuth().execute({});
  assert.deepEqual(calls.requests.map(request => request.init.headers.get('authorization')), ['Bearer token', null]);
});

test('the undeclared-response guard recognizes only its own SDK', async () => {
  const { Client, isUndeclared } = await loadTransportSdk();
  const undeclared = async (): Promise<Response> => new Response('nope', { status: 200, headers: { 'content-type': 'text/plain' } });
  const own: unknown = await new Client({ baseUrl: 'https://api.test', fetchImpl: undeclared, auth: { session: 's' } }).sessionAuth().execute({})
    .then(() => undefined, (caught: unknown) => caught);
  assert.ok(own instanceof LibError);
  assert.equal(isUndeclared(own), true);

  // The same failure raised by another client's runtime, and unrelated LibErrors, are not this SDK's.
  const foreign: unknown = await new ClientRuntime('Payments', { baseUrl: 'https://api.test' })
    .readResponse('ping', await undeclared(), [{ status: '204', content: [], headers: [] }], undefined)
    .then(() => undefined, (caught: unknown) => caught);
  assert.ok(foreign instanceof LibError);
  assert.equal(isUndeclared(foreign), false);
  assert.equal(isUndeclared(new LibError(LibErrorKind.Response, 'other')), false);
});
