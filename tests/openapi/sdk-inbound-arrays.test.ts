import assert from 'node:assert/strict';
import test from 'node:test';
import { fileFixtureScope, onceShared } from '../fixture-project.js';
import { importGeneratedModule } from './helpers.js';
import { loadSdk } from './sdk-client-fixture.js';

// The client writes an array parameter as its style says (R-80): the inbound handler of the same parameters reads it back to the same items.

const array = (items: unknown) => ({ type: 'array', items });
const INTEGERS = array({ type: 'integer' });
const STRINGS = array({ type: 'string' });
const PARAMETERS = [
  { name: 'ids', in: 'path', required: true, schema: INTEGERS },
  { name: 'names', in: 'path', required: true, schema: STRINGS },
  { name: 'X-Ids', in: 'header', schema: INTEGERS },
  { name: 'X-Tags', in: 'header', schema: STRINGS },
  { name: 'nums', in: 'query', explode: false, schema: INTEGERS },
  { name: 'words', in: 'query', explode: false, schema: STRINGS },
  { name: 'piped', in: 'query', style: 'pipeDelimited', schema: INTEGERS },
  { name: 'spaced', in: 'query', style: 'spaceDelimited', schema: STRINGS },
  { name: 'repeat', in: 'query', schema: INTEGERS },
  { name: 'amount', in: 'query', schema: { anyOf: [{ type: 'integer' }, { type: 'number' }] } },
];
const PATH = { ids: [0], names: ['x'] };
const NO_CONTENT = { 204: { description: 'No content' } };
const DOCUMENT = {
  openapi: '3.2.0',
  info: { title: 'Things', version: '1' },
  paths: { '/things/{ids}/{names}': { get: { operationId: 'searchThings', parameters: PARAMETERS, responses: NO_CONTENT } } },
  webhooks: { things: { post: { operationId: 'receiveThings', parameters: PARAMETERS, responses: NO_CONTENT } } },
};

type Handler = (request: unknown) => Promise<unknown>;
const sdk = onceShared(() => loadSdk<{ searchThings(): { execute(input: unknown): Promise<unknown> } }>(fileFixtureScope(), 'golem-openapi-inbound-arrays-', { document: DOCUMENT, name: 'Things', dates: 'date', validation: true }));

/** What the client writes for `input`, read as the framework gives it to an inbound handler: header names in lower case, path and query as text. */
async function sentRequest(input: unknown): Promise<Record<string, unknown>> {
  let sent: { readonly url: URL; readonly headers: Headers } | undefined;
  const { createClient } = await sdk();
  await createClient({ fetchImpl: async (url: string | URL, init?: RequestInit) => { sent = { url: new URL(String(url)), headers: new Headers(init?.headers) }; return new Response(null, { status: 204 }); } }).searchThings().execute(input);
  const { url, headers } = sent!;
  const [ids, names] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const query = Object.fromEntries([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : url.searchParams.getAll(key)]));
  return { path: { ids, names }, query, header: Object.fromEntries(headers) };
}

/** The input the port of the webhook gets when the handler reads `request`. */
async function received(request: unknown): Promise<Record<string, unknown>> {
  const { output } = await sdk();
  const bind = (await importGeneratedModule(output, 'generated SDK')).bindThingsInbound as (port: Record<string, (input: unknown) => Promise<unknown>>) => Record<string, Handler>;
  const inputs: Record<string, unknown>[] = [];
  const handlers = bind({ webhookReceiveThings: async (input) => { inputs.push(input as Record<string, unknown>); return { matched: 'status', status: 204, contentType: null, body: undefined, headers: {} }; } });
  await handlers.webhookReceiveThings!(request);
  return inputs[0]!;
}

for (const [name, input, location, field, expected] of [
  ['integers in a header', { path: PATH, header: { 'X-Ids': [1, 2] } }, 'header', 'X-Ids', [1, 2]],
  ['strings in a header', { path: PATH, header: { 'X-Tags': ['a', 'b'] } }, 'header', 'X-Tags', ['a', 'b']],
  ['integers in a path', { path: { ids: [1, 2], names: ['x'] } }, 'path', 'ids', [1, 2]],
  ['strings in a path', { path: { ids: [0], names: ['a', 'b'] } }, 'path', 'names', ['a', 'b']],
  ['integers in a form query without explode', { path: PATH, query: { nums: [3, 4] } }, 'query', 'nums', [3, 4]],
  ['strings in a form query without explode', { path: PATH, query: { words: ['c', 'd'] } }, 'query', 'words', ['c', 'd']],
  ['integers in a pipe delimited query', { path: PATH, query: { piped: [5, 6] } }, 'query', 'piped', [5, 6]],
  ['strings in a space delimited query', { path: PATH, query: { spaced: ['e', 'f'] } }, 'query', 'spaced', ['e', 'f']],
  ['integers in a repeated query key', { path: PATH, query: { repeat: [7, 8] } }, 'query', 'repeat', [7, 8]],
  ['a fraction in an integer or number query', { path: PATH, query: { amount: 1.5 } }, 'query', 'amount', 1.5],
] as const) {
  test(`the inbound handler reads what the client wrote: ${name}`, async () => {
    // protects: T-741 R-80 an inbound parameter decodes as its style says, as the golem client writes it
    const request = await sentRequest(input);
    const port = await received(request) as Record<string, Record<string, unknown>>;
    assert.deepEqual(port[location]![field], expected);
  });
}
