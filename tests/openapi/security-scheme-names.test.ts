import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import {
  captureRequest,
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedClientClass,
  requireRecord,
  type GeneratedClientClass,
} from './helpers.js';

// Scheme names that Object.prototype also has, and one that a document never declares.
const reserved = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];
const operationOf = (scheme: string): string => `use_${scheme}`;
// The first operation links to the second, with a request body that holds an own '__proto__' key and a link named '__proto__'.
const linked = { 204: { description: 'ok', links: Object.fromEntries([
  ['next', { operationId: operationOf('toString'), requestBody: Object.fromEntries([['__proto__', { kept: true }], ['plain', 1]]) }],
  ['__proto__', { operationId: operationOf('toString') }],
]) } };
const noContent = { 204: { description: 'ok' } };

function reservedDocument(): Record<string, unknown> {
  // Object.fromEntries defines own keys; plain assignment of '__proto__' would set a prototype instead.
  const securitySchemes = Object.fromEntries([
    ['bearer', { type: 'http', scheme: 'bearer' }],
    ...reserved.map((scheme) => [scheme, { type: 'apiKey', in: 'header', name: `X-${scheme}` }]),
  ]);
  const paths = Object.fromEntries([...reserved, 'valueOf'].map((scheme) => [
    `/auth/${scheme}`,
    { get: { operationId: operationOf(scheme), security: [{ [scheme]: [] }], responses: scheme === 'constructor' ? linked : noContent } },
  ]));
  return { openapi: '3.1.0', info: { title: 'Reserved', version: '1' }, components: { securitySchemes }, paths };
}

let sdk: { root: string; Client: GeneratedClientClass } | undefined;
after(() => {
  if (sdk) fs.rmSync(sdk.root, { recursive: true, force: true });
});

async function loadSdk(): Promise<{ root: string; Client: GeneratedClientClass }> {
  if (sdk) return sdk;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-openapi-reserved-schemes-')));
  await generateMaterializedSdk(reservedDocument(), { output: path.join(root, 'sdk'), name: 'Reserved', profile: { mobx: false, validation: false } });
  compileGeneratedSdk(path.join(root, 'sdk'), [], { strict: true });
  const module = requireRecord(await import(pathToFileURL(path.join(root, 'sdk/dist/index.js')).href), 'reserved client');
  if (!isGeneratedClientClass(module.ReservedClient)) throw new TypeError('ReservedClient must be a class');
  sdk = { root, Client: module.ReservedClient };
  return sdk;
}

async function call(scheme: string, auth: object, sent: Array<string | null> = []): Promise<unknown> {
  const { Client } = await loadSdk();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push(captureRequest(input as string, init).init.headers.get(`X-${scheme}`));
    return new Response(null, { status: 204 });
  };
  const client = new Client({ baseUrl: 'https://api.test', fetchImpl, auth });
  return Reflect.apply(Reflect.get(client, operationOf(scheme)), client, []).execute({});
}

for (const scheme of reserved) {
  test(`auth option reads the ${scheme} scheme only from its own keys`, async () => {
    // protects: T-510 a security scheme named like an Object.prototype member reads only own auth keys
    const sent: Array<string | null> = [];
    await assert.rejects(() => call(scheme, {}, sent), /No configured credentials satisfy/);
    await assert.rejects(() => call(scheme, { bearer: 'token' }, sent), /No configured credentials satisfy/);
    assert.deepEqual(sent, []);
    await call(scheme, { [scheme]: 'own-key' }, sent);
    await call(scheme, { [scheme]: () => 'lazy-key' }, sent);
    assert.deepEqual(sent, ['own-key', 'lazy-key']);
  });
}

test('a requirement that names an undeclared reserved word finds no scheme', async () => {
  // protects: T-510 an undeclared scheme named like an Object.prototype member is not a declared scheme
  await assert.rejects(() => call('valueOf', {}), /No configured credentials satisfy/);
  await assert.rejects(() => call('valueOf', { valueOf: 'x' }), /Unknown OpenAPI security scheme: valueOf/);
});

test('a document constant or link with a __proto__ key keeps it as an own key in the generated module', async () => {
  // protects: T-510 documentLiteral writes an own __proto__ key at any depth, not a prototype
  const { root } = await loadSdk();
  const links = requireRecord(await import(pathToFileURL(path.join(root, 'sdk/dist/links.js')).href), 'links module');
  const status = requireRecord(requireRecord(requireRecord(links.responseLinks, 'responseLinks')['use_constructor'], 'operation')['204'], 'status');
  const body = requireRecord(status.next, 'link').requestBody;
  assert.deepEqual(Object.keys(status), ['next', '__proto__']);
  assert.deepEqual(Object.entries(requireRecord(body, 'requestBody')), [['__proto__', { kept: true }], ['plain', 1]]);
});
