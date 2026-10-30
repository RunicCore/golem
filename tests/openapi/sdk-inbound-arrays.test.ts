import assert from 'node:assert/strict';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { fileFixtureScope, onceShared } from '../fixture-project.js';
import { importGeneratedModule } from './helpers.js';
import { loadSdk } from './sdk-client-fixture.js';

// The client writes an array parameter as its style says (R-80): the inbound handler of the same parameters reads it back to the same items.

const array = (items: unknown) => ({ type: 'array', items });
const INTEGERS = array({ type: 'integer' });
// A string item that can hold the separator of its style cannot be read back from text (OPENAPI_INBOUND_PARAMETER_AMBIGUOUS), so these items are a fixed set without one.
const WORD = { type: 'string', enum: ['a', 'b', 'c', 'd', 'e', 'f', 'x'] };
const STRINGS = array(WORD);
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
const STYLES = [
  ['labelInts', 'label', true, INTEGERS], ['labelIntsJoined', 'label', false, INTEGERS], ['labelWords', 'label', true, STRINGS], ['labelWordsJoined', 'label', false, STRINGS],
  ['matrixInts', 'matrix', true, INTEGERS], ['matrixIntsJoined', 'matrix', false, INTEGERS], ['matrixWords', 'matrix', true, STRINGS], ['matrixWordsJoined', 'matrix', false, STRINGS],
  ['labelOne', 'label', false, { type: 'integer' }], ['matrixOne', 'matrix', false, { type: 'string' }],
] as const;
const STYLED_PARAMETERS = STYLES.map(([name, style, explode, schema]) => ({ name, in: 'path', required: true, style, explode, schema }));
const STYLED_PATH = { labelInts: [0], labelIntsJoined: [0], labelWords: ['x'], labelWordsJoined: ['x'], matrixInts: [0], matrixIntsJoined: [0], matrixWords: ['x'], matrixWordsJoined: ['x'], labelOne: 0, matrixOne: 'x' };
const pair = (first: string, second: string) => ({ type: 'object', required: [first, second], properties: { [first]: { type: 'integer' }, [second]: WORD } });
const OBJECTS = [
  ['X-Flat', 'header', {}, pair('a', 'b')],
  ['X-Keyed', 'header', { explode: true }, pair('a', 'b')],
  ['plain', 'path', {}, pair('a', 'b')],
  ['plainKeyed', 'path', { explode: true }, pair('a', 'b')],
  ['dotted', 'path', { style: 'label' }, pair('a', 'b')],
  ['dottedKeyed', 'path', { style: 'label', explode: true }, pair('a', 'b')],
  ['semi', 'path', { style: 'matrix' }, pair('a', 'b')],
  ['semiKeyed', 'path', { style: 'matrix', explode: true }, pair('a', 'b')],
  ['formFlat', 'query', { explode: false }, pair('a', 'b')],
  ['formKeys', 'query', {}, pair('fa', 'fb')],
  ['deep', 'query', { style: 'deepObject' }, pair('a', 'b')],
  ['piped', 'query', { style: 'pipeDelimited' }, pair('a', 'b')],
  ['spaced', 'query', { style: 'spaceDelimited' }, pair('a', 'b')],
  ['merged', 'query', { explode: false }, { allOf: [{ type: 'object', properties: { a: { type: 'integer' } } }, { type: 'object', properties: { b: WORD } }] }],
  ['ckIds', 'cookie', {}, INTEGERS],
  ['ckJoined', 'cookie', { explode: false }, INTEGERS],
  ['ckStyle', 'cookie', { style: 'cookie', explode: false }, INTEGERS],
  ['ckObj', 'cookie', {}, pair('ca', 'cb')],
] as const;
const OBJECT_PARAMETERS = OBJECTS.map(([name, place, options, schema]) => ({ name, in: place, required: place === 'path', ...options, schema }));
const OBJECT_PATH_NAMES = OBJECTS.filter(([, place]) => place === 'path').map(([name]) => name);
const OBJECT_PATH = { plain: { a: 0, b: 'x' }, plainKeyed: { a: 0, b: 'x' }, dotted: { a: 0, b: 'x' }, dottedKeyed: { a: 0, b: 'x' }, semi: { a: 0, b: 'x' }, semiKeyed: { a: 0, b: 'x' } };
const NO_CONTENT = { 204: { description: 'No content' } };
const DOCUMENT = {
  openapi: '3.2.0',
  info: { title: 'Things', version: '1' },
  paths: {
    '/things/{ids}/{names}': { get: { operationId: 'searchThings', parameters: PARAMETERS, responses: NO_CONTENT } },
    [`/objects${OBJECT_PATH_NAMES.map(name => `/{${name}}`).join('')}`]: { get: { operationId: 'searchObjects', parameters: OBJECT_PARAMETERS, responses: NO_CONTENT } },
    [`/styled${STYLES.map(([name]) => `/{${name}}`).join('')}`]: { get: { operationId: 'searchStyled', parameters: STYLED_PARAMETERS, responses: NO_CONTENT } },
  },
  webhooks: {
    things: { post: { operationId: 'receiveThings', parameters: PARAMETERS, responses: NO_CONTENT } },
    styled: { post: { operationId: 'receiveStyled', parameters: STYLED_PARAMETERS, responses: NO_CONTENT } },
    objects: { post: { operationId: 'receiveObjects', parameters: OBJECT_PARAMETERS, responses: NO_CONTENT } },
  },
};

type Handler = (request: unknown) => Promise<unknown>;
const sdk = onceShared(() => loadSdk<Record<'searchThings' | 'searchStyled' | 'searchObjects', () => { execute(input: unknown): Promise<unknown> }>>(fileFixtureScope(), 'golem-openapi-inbound-arrays-', { document: DOCUMENT, name: 'Things', dates: 'date', validation: true }));

/** What the client writes for `input` to `operation`, read as the framework gives it to an inbound handler: header names in lower case, path and query as text. */
async function sentRequest(operation: 'searchThings' | 'searchStyled' | 'searchObjects', pathNames: readonly string[], input: unknown): Promise<Record<string, unknown>> {
  let sent: { readonly url: URL; readonly headers: Headers } | undefined;
  const { createClient } = await sdk();
  await createClient({ fetchImpl: async (url: string | URL, init?: RequestInit) => { sent = { url: new URL(String(url)), headers: new Headers(init?.headers) }; return new Response(null, { status: 204 }); } })[operation]().execute(input);
  const { url, headers } = sent!;
  const segments = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const query = Object.fromEntries([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : url.searchParams.getAll(key)]));
  const cookie: Record<string, unknown> = {};
  for (const part of (headers.get('cookie') ?? '').split('; ').filter(Boolean)) {
    const [key, value] = [part.slice(0, part.indexOf('=')), decodeURIComponent(part.slice(part.indexOf('=') + 1))];
    cookie[key] = key in cookie ? [cookie[key], value].flat() : value;
  }
  return { path: Object.fromEntries(pathNames.map((name, index) => [name, segments[index]])), query, header: Object.fromEntries(headers), ...(Object.keys(cookie).length ? { cookie } : {}) };
}

/** The input the port of the webhook `handler` gets when the handler reads `request`. */
async function received(handler: 'webhookReceiveThings' | 'webhookReceiveStyled' | 'webhookReceiveObjects', request: unknown): Promise<Record<string, unknown>> {
  const { output } = await sdk();
  const bind = (await importGeneratedModule(output, 'generated SDK')).bindThingsInbound as (port: Record<string, (input: unknown) => Promise<unknown>>) => Record<string, Handler>;
  const inputs: Record<string, unknown>[] = [];
  const answer = async (input: unknown) => { inputs.push(input as Record<string, unknown>); return { matched: 'status', status: 204, contentType: null, body: undefined, headers: {} }; };
  await bind({ webhookReceiveThings: answer, webhookReceiveStyled: answer, webhookReceiveObjects: answer })[handler]!(request);
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
    const request = await sentRequest('searchThings', ['ids', 'names'], input);
    const port = await received('webhookReceiveThings', request) as Record<string, Record<string, unknown>>;
    assert.deepEqual(port[location]![field], expected);
  });
}

for (const [name, field, value] of [
  ['integers in a label path with explode', 'labelInts', [1, 2]],
  ['integers in a label path without explode', 'labelIntsJoined', [1, 2]],
  ['strings in a label path with explode', 'labelWords', ['a', 'b']],
  ['strings in a label path without explode', 'labelWordsJoined', ['a', 'b']],
  ['integers in a matrix path with explode', 'matrixInts', [1, 2]],
  ['integers in a matrix path without explode', 'matrixIntsJoined', [1, 2]],
  ['strings in a matrix path with explode', 'matrixWords', ['a', 'b']],
  ['strings in a matrix path without explode', 'matrixWordsJoined', ['a', 'b']],
  ['an integer in a label path', 'labelOne', 5],
  ['a string in a matrix path', 'matrixOne', 'abc'],
] as const) {
  test(`the inbound handler reads a path parameter in its style: ${name}`, async () => {
    // protects: T-741 R-80 label and matrix path text reads back to the value the golem client wrote
    const request = await sentRequest('searchStyled', STYLES.map(([parameter]) => parameter), { path: { ...STYLED_PATH, [field]: value } });
    const port = await received('webhookReceiveStyled', { path: request.path }) as { path: Record<string, unknown> };
    assert.deepEqual(port.path[field], value);
  });
}

for (const [name, place, field, input, expected] of [
  ['a header in simple style', 'header', 'X-Flat', { header: { 'X-Flat': { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a header in simple style with explode', 'header', 'X-Keyed', { header: { 'X-Keyed': { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a path in simple style', 'path', 'plain', { path: { ...OBJECT_PATH, plain: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a path in simple style with explode', 'path', 'plainKeyed', { path: { ...OBJECT_PATH, plainKeyed: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a path in label style', 'path', 'dotted', { path: { ...OBJECT_PATH, dotted: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a path in label style with explode', 'path', 'dottedKeyed', { path: { ...OBJECT_PATH, dottedKeyed: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a path in matrix style', 'path', 'semi', { path: { ...OBJECT_PATH, semi: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a path in matrix style with explode', 'path', 'semiKeyed', { path: { ...OBJECT_PATH, semiKeyed: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a query in form style without explode', 'query', 'formFlat', { path: OBJECT_PATH, query: { formFlat: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a query in form style with explode', 'query', 'formKeys', { path: OBJECT_PATH, query: { formKeys: { fa: 1, fb: 'x' } } }, { fa: 1, fb: 'x' }],
  ['a query in deepObject style', 'query', 'deep', { path: OBJECT_PATH, query: { deep: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a query in pipeDelimited style', 'query', 'piped', { path: OBJECT_PATH, query: { piped: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a query in spaceDelimited style', 'query', 'spaced', { path: OBJECT_PATH, query: { spaced: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['a query whose object is an allOf', 'query', 'merged', { path: OBJECT_PATH, query: { merged: { a: 1, b: 'x' } } }, { a: 1, b: 'x' }],
  ['integers in a repeated cookie', 'cookie', 'ckIds', { path: OBJECT_PATH, cookie: { ckIds: [1, 2] } }, [1, 2]],
  ['integers in a joined cookie', 'cookie', 'ckJoined', { path: OBJECT_PATH, cookie: { ckJoined: [3, 4] } }, [3, 4]],
  ['integers in a cookie of style cookie', 'cookie', 'ckStyle', { path: OBJECT_PATH, cookie: { ckStyle: [5, 6] } }, [5, 6]],
  ['an object in cookies', 'cookie', 'ckObj', { path: OBJECT_PATH, cookie: { ckObj: { ca: 1, cb: 'x' } } }, { ca: 1, cb: 'x' }],
] as const) {
  test(`the inbound handler reads an object parameter in its style: ${name}`, async () => {
    // protects: T-746 R-80 an object parameter reads back to the object the golem client wrote, a number as a number
    const request = await sentRequest('searchObjects', OBJECT_PATH_NAMES, { path: OBJECT_PATH, ...input });
    const port = await received('webhookReceiveObjects', request) as Record<string, Record<string, unknown>>;
    assert.deepEqual(port[place]![field], expected);
  });
}

test('an object parameter whose text does not fit its style stays text and the check rejects it', async () => {
  // protects: T-746 text that does not match the style is left for the validator to report
  const request = await sentRequest('searchObjects', OBJECT_PATH_NAMES, { path: OBJECT_PATH });
  await assert.rejects(received('webhookReceiveObjects', { ...request, query: { formFlat: 'a,1,b' } }), (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.causedByInput === true);
});
