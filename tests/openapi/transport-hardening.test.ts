import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/codegen/errors';
import { createFixtureProject } from '../fixture-project.js';
import {
  captureRequest,
  compileGeneratedSdk,
  generateMaterializedSdk,
  isAsyncIterable,
  isGeneratedClientClass,
  requireRecord,
  type CapturedRequest,
  type GeneratedClientClass,
  type OpenApiGenerationProfile,
} from './helpers.js';

const noContent = { 204: { description: 'done' } };

function transportDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Transport', version: '1' },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        basic: { type: 'http', scheme: 'basic' },
        session: { type: 'apiKey', in: 'cookie', name: 'session' },
      },
    },
    paths: {
      '/optional-auth': { get: { operationId: 'optionalAuth', security: [{}, { bearer: [] }], responses: noContent } },
      '/basic': { get: { operationId: 'basicAuth', security: [{ basic: [] }], responses: noContent } },
      '/session': { get: { operationId: 'sessionAuth', security: [{ session: [] }], responses: noContent } },
      '/empty': { delete: { operationId: 'emptyResponse', responses: noContent } },
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
      '/deep': {
        get: {
          operationId: 'deepQuery',
          parameters: [{
            name: 'filter',
            in: 'query',
            style: 'deepObject',
            explode: true,
            schema: {
              type: 'object',
              properties: {
                owner: { type: 'object', properties: { name: { type: 'string' }, nick: { type: ['string', 'null'] }, team: { type: 'object', properties: { id: { type: 'integer' } } } } },
                kind: { type: 'string' },
              },
            },
          }],
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
      '/events': {
        get: {
          operationId: 'events',
          responses: {
            200: {
              description: 'events',
              content: { 'text/event-stream': { itemSchema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
}

async function transportClient(
  t: Parameters<typeof createFixtureProject>[0],
  profile: OpenApiGenerationProfile,
): Promise<{
  Client: GeneratedClientClass;
  isUndeclared: (error: unknown) => boolean;
  diagnostics: readonly { code: string }[];
}> {
  const output = path.join(createFixtureProject(t, 'runic-openapi-transport-'), 'sdk');
  const document = { ...transportDocument(), openapi: '3.2.0' };
  const result = await generateMaterializedSdk(document, { output, name: 'Transport', profile });
  compileGeneratedSdk(output, [], { strict: true });
  const module = requireRecord(await import(pathToFileURL(path.join(output, 'dist/client.js')).href), 'transport client');
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

test('generated transport honors OAS security, encoding, response, and stream rules', async suite => {
  for (const profile of [{ mobx: false, validation: false }, { mobx: true, validation: true }] as const) {
    await suite.test(`validation=${profile.validation}`, async t => {
    const { Client, isUndeclared, diagnostics } = await transportClient(t, profile);

    // Cookie parameters and cookie API keys cannot be sent from a browser.
    assert.deepEqual(
      diagnostics.map(diagnostic => diagnostic.code).sort(),
      ['OPENAPI_BROWSER_COOKIE', 'OPENAPI_BROWSER_COOKIE'],
    );

    // An optional requirement ({}) is a fallback: configured credentials are still sent.
    let calls = recorder();
    await new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl, auth: { bearer: 'token' } }).optionalAuth().execute({});
    await new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl }).optionalAuth().execute({});
    assert.deepEqual(calls.requests.map(request => request.init.headers.get('authorization')), ['Bearer token', null]);

    // Basic credentials are UTF-8 encoded before base64.
    calls = recorder();
    await new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl, auth: { basic: { username: 'jürgen', password: 'π' } } }).basicAuth().execute({});
    // RFC 7617: the user-id cannot contain a colon.
    await assert.rejects(
      () => new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl, auth: { basic: { username: 'a:b', password: 'p' } } }).basicAuth().execute({}),
      /must not contain ":"/,
    );
    assert.equal(calls.requests[0]?.init.headers.get('authorization'), `Basic ${Buffer.from('jürgen:π', 'utf8').toString('base64')}`);

    // allowReserved keeps #[]&+ encoded and passes existing %XX triples through; names are literal.
    calls = recorder();
    await new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl }).reservedQuery().execute({
      query: { q: 'a/b?c#d[e]&f+g%20h:@!$', 'this.id': 'x' },
    });
    assert.equal(calls.requests[0]?.url, 'https://api.test/reserved?q=a/b?c%23d%5Be%5D%26f%2Bg%20h:@!$&this.id=x');

    // Nested deepObject values serialize recursively.
    calls = recorder();
    await new Client({ baseUrl: 'https://api.test', fetchImpl: calls.fetchImpl }).deepQuery().execute({
      query: { filter: { owner: { name: 'Ann', nick: null, team: { id: 7 } }, kind: 'x' } },
    });
    assert.equal(
      calls.requests[0]?.url,
      'https://api.test/deep?filter[owner][name]=Ann&filter[owner][team][id]=7&filter[kind]=x',
    );

    // A declared response without content ignores (and cancels) a body the server sends anyway.
    let cancelled = false;
    const unexpectedBody = () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('unexpected')); },
      cancel() { cancelled = true; },
    });
    const declaredEmpty = recorder(() => {
      // Response forbids a 204 body; the stub reports 204 for a response that still carries one.
      const response = new Response(unexpectedBody(), { status: 200, headers: { 'content-type': 'text/plain' } });
      Object.defineProperty(response, 'status', { value: 204 });
      return response;
    });
    const emptyStatus = recorder(() => new Response(unexpectedBody(), { status: 200, headers: { 'content-type': 'text/plain' } }));
    const empty = await new Client({ baseUrl: 'https://api.test', fetchImpl: declaredEmpty.fetchImpl }).emptyResponse().execute({});
    assert.equal(empty.status, 204);
    assert.equal(empty.body, undefined);
    assert.equal(cancelled, true, 'the unread body is cancelled');

    // An undeclared status is a response LibError carrying its facts; the body is cancelled.
    cancelled = false;
    await assert.rejects(
      () => new Client({ baseUrl: 'https://api.test', fetchImpl: emptyStatus.fetchImpl }).emptyResponse().execute({}),
      (error: unknown) => error instanceof LibError
        && error.kind === LibErrorKind.Response
        && isUndeclared(error)
        && Reflect.get(error, 'operation') === 'emptyResponse'
        && Reflect.get(error, 'status') === 200
        && Reflect.get(error, 'contentType') === 'text/plain'
        && Reflect.get(error, 'headers') instanceof Headers
        && Reflect.get(error, 'headers').get('content-type') === 'text/plain',
    );
    assert.equal(cancelled, true, 'the undeclared response body is cancelled');
    assert.equal(isUndeclared(new LibError(LibErrorKind.Response, 'other')), false);

    const readEvents = async (chunks: readonly (string | Uint8Array)[]): Promise<unknown[]> => {
      const stream = recorder(() => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      const events = await new Client({ baseUrl: 'https://api.test', fetchImpl: stream.fetchImpl }).events().execute({});
      assert.ok(isAsyncIterable(events.body));
      const received: unknown[] = [];
      for await (const event of events.body) received.push(event);
      return received;
    };
    // A CRLF split across chunks does not dispatch early; a partial event at EOF is dropped.
    assert.deepEqual(await readEvents(['data: a\r', '\ndata: b\r\n\r\n', 'data: partial']), [{ data: 'a\nb' }]);
    // A data-less event discards its type; the next event does not inherit it.
    assert.deepEqual(await readEvents(['event: ping\n\n', 'data: x\n\n']), [{ data: 'x' }]);
    // A multi-byte UTF-8 character split across chunks, inside a data line and
    // right before a line boundary, decodes intact.
    const splitAt = (text: string, marker: string, offset: number): Uint8Array[] => {
      const bytes = new TextEncoder().encode(text);
      const cut = new TextEncoder().encode(text.slice(0, text.indexOf(marker))).length + offset;
      return [bytes.slice(0, cut), bytes.slice(cut)];
    };
    assert.deepEqual(await readEvents(splitAt('data: 1€2\n\n', '€', 1)), [{ data: '1€2' }]);
    assert.deepEqual(await readEvents(splitAt('data: 😀\r\n\r\n', '😀', 3)), [{ data: '😀' }]);
    assert.deepEqual(await readEvents([...splitAt('data: €', '€', 2), '\n\n']), [{ data: '€' }]);
    // A CR at the end of the stream still ends the blank line that dispatches.
    assert.deepEqual(await readEvents(['data: a\n', '\r']), [{ data: 'a' }]);
    });
  }
});
