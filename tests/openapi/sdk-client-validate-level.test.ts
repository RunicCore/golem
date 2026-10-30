import 'temporal-polyfill/global';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { fileFixtureScope, onceShared } from '../fixture-project.js';
import { loadSdk, type LoadedSdk } from './sdk-client-fixture.js';

// The client takes a validation level per client and per call, request and response apart (R-86). The amount limit (maximum 100)
// is a value limit: the sanity level skips it. A string amount breaks the shape: only `false` lets it through.

const CHARGE = { type: 'object', additionalProperties: false, required: ['amount', 'when'], properties: { amount: { type: 'integer', maximum: 100 }, when: { type: 'string', format: 'date-time' } } };
const JSON_CHARGE = { 'application/json': { schema: CHARGE } };
const HEADER_PARAMETERS = [
  { name: 'X-Limit', in: 'header', schema: { type: 'integer', maximum: 100 } },
  { name: 'X-Since', in: 'header', schema: { type: 'string', format: 'date-time' } },
];
const DOCUMENT = {
  openapi: '3.2.0',
  info: { title: 'Charges', version: '1' },
  paths: { '/charges': { post: {
    operationId: 'createCharge',
    parameters: HEADER_PARAMETERS,
    requestBody: { required: true, content: JSON_CHARGE },
    responses: { 200: { description: 'Created', content: JSON_CHARGE, headers: { 'X-Seen': { schema: { type: 'string', format: 'date-time' } } } } },
  } } },
};

type Level = 'full' | 'sanity' | 'off';
type Setting = true | 'sanity' | false;
type Validate = Setting | { request?: Setting; response?: Setting; requestHeaders?: Setting; responseHeaders?: Setting };
type ChargesClient = { createCharge(): { execute(input: unknown, options?: { validate?: unknown }): Promise<{ body: { when: unknown }; headers: Record<string, unknown> }> } };

const scope = fileFixtureScope();
const sdks = {
  full: onceShared(() => loadSdk<ChargesClient>(scope, 'golem-sdk-validate-full-', { document: DOCUMENT, name: 'Charges', dates: 'date', validation: true })),
  sanity: onceShared(() => loadSdk<ChargesClient>(scope, 'golem-sdk-validate-sanity-', { document: DOCUMENT, name: 'Charges', dates: 'date', validation: 'sanity' })),
};

const WHEN = '2025-01-02T03:04:05.000Z';
/** What a call does with a value that breaks the limit and with one that breaks the shape, at each level. */
const OUTCOMES: Readonly<Record<Level, readonly string[]>> = {
  full: [LibErrorKind.Validation, LibErrorKind.Validation],
  sanity: ['accepted', LibErrorKind.Validation],
  off: ['accepted', 'accepted'],
};

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'accepted';
  } catch (error) {
    return error instanceof LibError ? error.kind : String(error);
  }
}

/** A client that answers `amount`, and the number of requests it was asked to send. */
function chargesClient(sdk: LoadedSdk<ChargesClient>, validate: Validate | undefined, answer: unknown, sent: unknown[]): ChargesClient {
  return sdk.createClient({
    ...(validate === undefined ? {} : { validate }),
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init?.body);
      return Response.json({ amount: answer, when: WHEN });
    },
  });
}

/** The four outcomes of a configuration: the request with an amount over the limit and with a string, the response with each. */
async function outcomes(sdk: LoadedSdk<ChargesClient>, client: Validate | undefined, call: Validate | undefined): Promise<string[]> {
  const run = async (sent: unknown, answered: unknown): Promise<string> => outcome(() => chargesClient(sdk, client, answered, []).createCharge().execute({ body: { amount: sent, when: new Date(WHEN) } }, call === undefined ? undefined : { validate: call }));
  return [await run(500, 1), await run('x', 1), await run(1, 500), await run(1, 'x')];
}

const LEVELS: ReadonlyArray<readonly [string, 'full' | 'sanity', Validate | undefined, Validate | undefined, Level, Level]> = [
  ['no option takes the SDK level', 'full', undefined, undefined, 'full', 'full'],
  ['client sanity lowers both sides', 'full', 'sanity', undefined, 'sanity', 'sanity'],
  ['client false turns both sides off', 'full', false, undefined, 'off', 'off'],
  ['client response false leaves the request full', 'full', { response: false }, undefined, 'full', 'off'],
  ['client request sanity leaves the response full', 'full', { request: 'sanity' }, undefined, 'sanity', 'full'],
  ['call true lifts a client sanity back to the SDK level', 'full', 'sanity', true, 'full', 'full'],
  ['call response sanity wins over client false on one side only', 'full', false, { response: 'sanity' }, 'off', 'sanity'],
  ['call false turns both sides off', 'full', undefined, false, 'off', 'off'],
  ['call request false and client response sanity', 'full', { response: 'sanity' }, { request: false }, 'off', 'sanity'],
  ['sanity SDK without options checks the shape', 'sanity', undefined, undefined, 'sanity', 'sanity'],
  ['sanity SDK, call false', 'sanity', undefined, false, 'off', 'off'],
  ['sanity SDK, client response false', 'sanity', { response: false }, undefined, 'sanity', 'off'],
  ['sanity SDK, call sanity', 'sanity', undefined, 'sanity', 'sanity', 'sanity'],
];

for (const [name, sdkLevel, client, call, request, response] of LEVELS) {
  test(`validate level: ${name}`, async () => {
    // protects: R-86 call, then client, then SDK level, per side; conversion runs at every level
    assert.deepEqual(await outcomes(await sdks[sdkLevel](), client, call), [...OUTCOMES[request], ...OUTCOMES[response]]);
  });
}

const ABOVE_SDK_LEVEL: ReadonlyArray<readonly [string, Validate | undefined, Validate | undefined]> = [
  ['call true', undefined, true],
  ['client true', true, undefined],
  ['call request true', undefined, { request: true }],
  ['client response true', { response: true }, undefined],
  ['call request headers true', undefined, { requestHeaders: true }],
  ['client response headers true', { responseHeaders: true }, undefined],
];

for (const [name, client, call] of ABOVE_SDK_LEVEL) {
  test(`a sanity SDK refuses a level above its own: ${name}`, async () => {
    // protects: R-72, R-86 lower only: a higher request throws ValidationUnavailable and nothing is sent
    const sent: unknown[] = [];
    await assert.rejects(
      chargesClient(await sdks.sanity(), client, 1, sent).createCharge().execute({ body: { amount: 1, when: new Date(WHEN) } }, call === undefined ? undefined : { validate: call }),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable,
    );
    assert.deepEqual(sent, []);
  });
}

for (const [name, client, call] of [
  ['an unknown level', 'strict', undefined],
  ['null', undefined, null],
  ['zero', 0, undefined],
  ['an array', undefined, [true]],
  ['a misspelled side', { requests: false }, undefined],
  ['an unknown side level', undefined, { response: 'strict' }],
] as const) {
  test(`validate takes true, 'sanity', false or request and response sides: ${name} is a TypeError`, async () => {
    // protects: R-72 any other value is a TypeError, never read as off
    const sent: unknown[] = [];
    await assert.rejects(
      chargesClient(await sdks.full(), client as Validate | undefined, 1, sent).createCharge().execute({ body: { amount: 1, when: new Date(WHEN) } }, call === undefined ? undefined : { validate: call }),
      TypeError,
    );
    assert.deepEqual(sent, []);
  });
}

/** The outcomes of a header over the limit, a header of the wrong type, and a response header that is no date. */
async function headerOutcomes(validate: Validate | undefined): Promise<string[]> {
  const sdk = await sdks.full();
  const run = (limit: unknown, seen: string): Promise<string> => outcome(() => sdk.createClient({
    ...(validate === undefined ? {} : { validate }),
    fetchImpl: async () => Response.json({ amount: 1, when: WHEN }, { headers: { 'X-Seen': seen } }),
  }).createCharge().execute({ header: { 'X-Limit': limit, 'X-Since': new Date(WHEN) }, body: { amount: 1, when: new Date(WHEN) } }));
  return [await run(500, WHEN), await run('x', WHEN), await run(1, 'nope')];
}

for (const [name, validate, expected] of [
  ['by default', undefined, ['accepted', 'accepted', LibErrorKind.Deserialization]],
  ['a full request and response do not switch them', true, ['accepted', 'accepted', LibErrorKind.Deserialization]],
  ['request headers on', { requestHeaders: true }, [LibErrorKind.Validation, LibErrorKind.Validation, LibErrorKind.Deserialization]],
  ['request headers at sanity', { requestHeaders: 'sanity' }, ['accepted', LibErrorKind.Validation, LibErrorKind.Deserialization]],
  ['response headers on', { responseHeaders: true }, ['accepted', 'accepted', LibErrorKind.Validation]],
  ['both on', { requestHeaders: true, responseHeaders: true }, [LibErrorKind.Validation, LibErrorKind.Validation, LibErrorKind.Validation]],
] as const) {
  test(`header checks ${name}`, async () => {
    // protects: R-86 header checks are off by default and switch apart from bodies and from each other; the bad date is rejected by conversion when its check is off
    assert.deepEqual(await headerOutcomes(validate as Validate | undefined), expected);
  });
}

test('a header that breaks its schema passes by default and its dates convert', async () => {
  // protects: R-86 dates in headers convert when header checks are off
  const sdk = await sdks.full();
  const sent: Headers[] = [];
  const client = sdk.createClient({ fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return Response.json({ amount: 1, when: WHEN }, { headers: { 'X-Seen': WHEN } });
  } });
  const response = await client.createCharge().execute({ header: { 'X-Limit': 500, 'X-Since': new Date(WHEN) }, body: { amount: 1, when: new Date(WHEN) } });
  assert.deepEqual(sent.map(headers => [headers.get('x-limit'), headers.get('x-since')]), [['500', WHEN]]);
  assert.ok(response.headers['X-Seen'] instanceof Date);
});

test('a response is checked once: the client check is the only wire check before decoding', async () => {
  // protects: R-86, F-164 the decoder does not check the wire body again; an override that accepts it is the last word
  const sdk = await sdks.full();
  const checked: unknown[] = [];
  const accept = (value: unknown): readonly [] => { checked.push(value); return []; };
  const client = sdk.createClient({
    operationValidators: new Map([['createCharge', { input: () => [], responses: new Map([['200:application/json', accept]]) }]]),
    fetchImpl: async () => Response.json({ amount: 'x', when: WHEN }),
  });
  const response = await client.createCharge().execute({ body: { amount: 1, when: new Date(WHEN) } });
  assert.deepEqual(checked, [{ amount: 'x', when: WHEN }]);
  assert.deepEqual(response.body, { amount: 'x', when: new Date(WHEN) });
});

test('a leap-second date passes the wire check and is still rejected when it cannot convert', async () => {
  // protects: R-86 skipping the decoder's own check loses nothing: a wire date that is no Date never arrives as one
  const client = (await sdks.full()).createClient({ fetchImpl: async () => Response.json({ amount: 1, when: '2025-12-31T23:59:60Z' }) });
  await assert.rejects(
    client.createCharge().execute({ body: { amount: 1, when: new Date(WHEN) } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Deserialization,
  );
});

test('with response validation off a bad date is a deserialization error: conversion still runs', async () => {
  // protects: R-86 { response: false } turns the check off, not the conversion
  const sdk = await sdks.full();
  const answer = (when: string) => sdk.createClient({ validate: { response: false }, fetchImpl: async () => Response.json({ amount: 1, when }) });
  const good = await answer(WHEN).createCharge().execute({ body: { amount: 1, when: new Date(WHEN) } });
  assert.ok(good.body.when instanceof Date);
  await assert.rejects(
    answer('not a date').createCharge().execute({ body: { amount: 1, when: new Date(WHEN) } }),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Deserialization && error.causedByInput === true,
  );
});
