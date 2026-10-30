import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { createFixtureProject } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, importGeneratedModule, isGeneratedClientClass, requireRecord } from './helpers.js';

// The client converts what it carries (R-80): parameters leave in their wire form and response headers arrive in their plain form.

const MOMENT = { $ref: '#/components/schemas/Moment' };
const DATE_TIME = { type: 'string', format: 'date-time' };

const DOCUMENT = {
  openapi: '3.2.0',
  info: { title: 'Moments', version: '1' },
  paths: {
    '/moments/{at}': { get: { operationId: 'getMoment', parameters: [{ name: 'at', in: 'path', required: true, schema: MOMENT }], responses: { 204: { description: 'Found' } } } },
    '/search': { get: { operationId: 'searchMoments', parameters: [
      { name: 'since', in: 'query', schema: DATE_TIME },
      { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 10 } },
    ], responses: { 204: { description: 'Found' } } } },
    '/with-header': { get: { operationId: 'readWithHeader', parameters: [{ name: 'X-Since', in: 'header', schema: DATE_TIME }], responses: { 204: { description: 'Found', headers: { 'Last-Modified': { schema: DATE_TIME }, 'X-Count': { schema: { type: 'integer' } } } } } } },
    '/plain/{id}': { get: { operationId: 'getPlain', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } }], responses: { 204: { description: 'Found' } } } },
  },
  components: { schemas: { Moment: DATE_TIME } },
};

type Operation = { execute(input: unknown): Promise<{ status: number; headers: Record<string, unknown> }> };
type MomentsClient = Record<string, () => Operation>;
interface Fetched { readonly url: string; readonly headers: Record<string, string> }

/** Generates the SDK with `dates` and returns a client whose fetch answers `reply` and records the URL and headers of each request, and the folder of the SDK. */
async function loadClient(t: Parameters<typeof createFixtureProject>[0], dates: 'date' | 'temporal', reply: () => Response, sent: Fetched[]): Promise<{ readonly client: MomentsClient; readonly output: string }> {
  const output = path.join(createFixtureProject(t, `golem-openapi-parameter-conversion-${dates}-`), 'sdk');
  await generateMaterializedSdk(DOCUMENT, { output, name: 'Moments', profile: { mobx: false, validation: true, allowAny: false }, dates });
  compileGeneratedSdk(output, [], { strict: true, lib: ['ES2023', 'DOM', 'DOM.Iterable', 'esnext.temporal'] });
  const sdk = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated SDK');
  assert.ok(isGeneratedClientClass(sdk.MomentsClient), 'generated client');
  const client = new sdk.MomentsClient({
    baseUrl: 'https://api.test',
    fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) });
      return reply();
    },
  }) as unknown as MomentsClient;
  return { client, output };
}

const NO_CONTENT = () => new Response(null, { status: 204 });

test('a $ref date path parameter is sent as its wire string', async t => {
  // protects: R-80 a $ref parameter typed as the converted component is encoded before it is sent
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', NO_CONTENT, sent);
  await client.getMoment!().execute({ path: { at: new Date('2025-01-02T03:04:05Z') } });
  assert.deepEqual(sent.map(item => item.url), ['https://api.test/moments/2025-01-02T03%3A04%3A05.000Z']);
});

test('with dates: temporal an inline date query parameter is sent as its wire string', async t => {
  // protects: R-80 an inline parameter is typed converted and encoded before it is sent
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'temporal', NO_CONTENT, sent);
  await client.searchMoments!().execute({ query: { since: Temporal.Instant.from('2025-01-02T03:04:05Z'), limit: 5 } });
  assert.deepEqual(sent.map(item => item.url), ['https://api.test/search?since=2025-01-02T03%3A04%3A05Z&limit=5']);
});

test('a date header parameter is sent as its wire string', async t => {
  // protects: R-80 a header parameter is encoded before it is sent
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', NO_CONTENT, sent);
  await client.readWithHeader!().execute({ header: { 'X-Since': new Date('2025-01-02T03:04:05Z') } });
  assert.equal(sent[0]?.headers['x-since'], '2025-01-02T03:04:05.000Z');
});

test('a response header with a date arrives as a Date and the other headers are decoded as before', async t => {
  // protects: R-80 a response header is decoded after its check
  const sent: Fetched[] = [];
  const reply = () => new Response(null, { status: 204, headers: { 'Last-Modified': '2025-01-02T03:04:05Z', 'X-Count': '7' } });
  const { client } = await loadClient(t, 'date', reply, sent);
  const response = await client.readWithHeader!().execute({});
  const modified = response.headers['Last-Modified'];
  assert.ok(modified instanceof Date);
  assert.equal(modified.toISOString(), '2025-01-02T03:04:05.000Z');
  assert.equal(response.headers['X-Count'], 7);
});

test('a bad response header date is a validation error caused by input', async t => {
  // protects: R-80 the wire check of a header runs before decode, so a header that is no date is rejected
  const { client } = await loadClient(t, 'date', () => new Response(null, { status: 204, headers: { 'Last-Modified': 'yesterday' } }), []);
  await assert.rejects(
    client.readWithHeader!().execute({}),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === true,
  );
});

test('a bad parameter value is a validation error caused by input and never reaches fetch', async t => {
  // protects: R-80 the wire parameters are checked before fetch
  const sent: Fetched[] = [];
  const { client } = await loadClient(t, 'date', NO_CONTENT, sent);
  await assert.rejects(
    client.searchMoments!().execute({ query: { since: new Date('2025-01-02T03:04:05Z'), limit: 99 } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === true,
  );
  assert.deepEqual(sent, []);
});

test('parameters with nothing to convert are sent unchanged and their operation has no parameter codec', async t => {
  // protects: R-80 identity parameters have no codec entry at all
  const sent: Fetched[] = [];
  const { client, output } = await loadClient(t, 'date', NO_CONTENT, sent);
  await client.getPlain!().execute({ path: { id: 'a b' }, query: { q: 'x' } });
  assert.deepEqual(sent.map(item => item.url), ['https://api.test/plain/a%20b?q=x']);
  const codecs = (name: string) => importGeneratedModule(output, `${name} codecs`, `dist/codecs/${name}.js`);
  assert.deepEqual(Object.keys(requireRecord((await codecs('getPlain')).operationCodecs, 'getPlain codecs')), ['input']);
  assert.deepEqual(Object.keys(requireRecord((await codecs('searchMoments')).operationCodecs, 'searchMoments codecs')), ['input', 'parameters']);
});
