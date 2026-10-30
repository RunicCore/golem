import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { LibError, LibErrorKind, IssueSource } from '@exprtlabs/golem/errors';
import {
  GENERATION_PROFILES,
  PROFILE_IDS,
} from '../../packages/golem-openapi/compliance/capabilities.js';
import { generate, loadValidatedDocument } from '@exprtlabs/golem-openapi/generator';
import { normalizeDocument } from '#openapi/normalize';
import {
  assertCaseTableIntegrity,
  caseKey,
  INBOUND_CONTRACT_CASES,
  UPSTREAM_OPERATION_CASES,
  type UpstreamOperationCase,
  type UpstreamResponseCase,
} from './compliance-cases.js';
import {
  isGeneratedClientClass,
  generateMaterializedSdk,
  openApiFixture,
  repoRoot,
  requireRecord,
  tscBin,
} from './helpers.js';

const fixtureRoot = openApiFixture('fixtures/upstream');

interface UpstreamFixture {
  readonly path: string;
  readonly sha256: string;
  readonly version: '3.1' | '3.2';
}

interface UpstreamManifest {
  readonly fixtures: readonly UpstreamFixture[];
  readonly sources: readonly { readonly commit: string; readonly licenseFile: string }[];
}

interface GeneratedOperationModule {
  readonly [name: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifest(filename: string): UpstreamManifest {
  const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!isRecord(value) || !Array.isArray(value.fixtures) || !Array.isArray(value.sources)) {
    throw new TypeError('invalid upstream manifest');
  }
  const fixtures: UpstreamFixture[] = [];
  for (const fixture of value.fixtures) {
    if (!isRecord(fixture) || typeof fixture.path !== 'string' || typeof fixture.sha256 !== 'string') {
      throw new TypeError('invalid upstream fixture');
    }
    if (fixture.version !== '3.1' && fixture.version !== '3.2') {
      throw new TypeError(`unsupported fixture version ${String(fixture.version)}`);
    }
    fixtures.push({ path: fixture.path, sha256: fixture.sha256, version: fixture.version });
  }
  const sources: UpstreamManifest['sources'][number][] = [];
  for (const source of value.sources) {
    if (!isRecord(source) || typeof source.commit !== 'string' || typeof source.licenseFile !== 'string') {
      throw new TypeError('invalid upstream source');
    }
    sources.push({ commit: source.commit, licenseFile: source.licenseFile });
  }
  return { fixtures, sources };
}

const manifest = readManifest(path.join(fixtureRoot, 'manifest.json'));

function compileStrict(output: string): void {
  const compiled = spawnSync(process.execPath, [tscBin(), 
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--lib', 'ES2023,ESNext.Collection,DOM,DOM.Iterable',
    '--strict',
    '--noUnusedLocals',
    '--noUnusedParameters',
    '--noEmitOnError',
    '--skipLibCheck',
    '--rootDir', output,
    '--outDir', path.join(output, 'dist'),
    path.join(output, 'index.ts'),
  ], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
}

function artifactNames(result: Awaited<ReturnType<typeof generate>>): readonly string[] {
  const index = result.artifacts.find(({ path: filename }) => path.basename(filename) === 'index.ts');
  assert.ok(index, 'generated index.ts');
  return result.artifacts.map(({ path: filename }) => path.relative(path.dirname(index.path), filename)).sort();
}

function hasResponseLinks(ir: ReturnType<typeof normalizeDocument>): boolean {
  return ir.operations.some((operation) => operation.responses.some((response) => Object.keys(response.links).length > 0));
}

function assertArtifactInventory(
  result: Awaited<ReturnType<typeof generate>>,
  ir: ReturnType<typeof normalizeDocument>,
): void {
  const files = artifactNames(result);
  const manifestArtifact = result.artifacts.find(({ path: filename }) => path.basename(filename) === 'model-manifest.json');
  assert.ok(manifestArtifact, 'generated model manifest');
  const schemaModules = files.filter(file => /^validation-schemas\/[A-Za-z0-9_$-]+\.(?:input|output)(?:-[0-9a-f]{6})?\.ts$|^validation-schemas\/resource-[0-9a-f]{12}\.ts$/.test(file));
  for (const module of schemaModules) {
    const importPath = `../${module.replace(/\.ts$/, '.js')}`;
    assert.ok(result.artifacts.some(artifact => artifact.content.includes(importPath)), `${module} is in an operation dependency closure`);
  }
  if (hasResponseLinks(ir)) {
    const links = result.artifacts.find(({ path: filename }) => filename.endsWith('/links.ts'))?.content;
    assert.ok(links, 'response Link Objects artifact');
  }
  if (ir.inboundOperations.length) {
    const inbound = result.artifacts.find(({ path: filename }) => filename.endsWith('/inbound.ts'))?.content;
    assert.ok(inbound, 'inbound contract artifact');
    for (const operation of ir.inboundOperations) {
      const escapedName = operation.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Kept pin: inbound.ts holds types only, so no value runs; the name is the contract's member.
      assert.match(inbound, new RegExp(`\\b${escapedName}\\b`));
    }
  }
}

function lookupCasesForFixture(fixture: UpstreamFixture): readonly UpstreamOperationCase[] {
  return UPSTREAM_OPERATION_CASES.filter((item) => item.fixture === fixture.path);
}

function assertOperationCaseCoverage(
  fixture: UpstreamFixture,
  ir: ReturnType<typeof normalizeDocument>,
): readonly UpstreamOperationCase[] {
  const cases = lookupCasesForFixture(fixture);
  const expected = new Set(ir.operations.map((operation) => caseKey(fixture.path, operation.name)));
  const actual = new Set(cases.map((item) => caseKey(item.fixture, item.operation)));
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${fixture.path} operation cases`);
  for (const item of cases) assert.equal(item.version, fixture.version);
  return cases;
}

function assertInboundCaseCoverage(
  fixture: UpstreamFixture,
  ir: ReturnType<typeof normalizeDocument>,
): void {
  const cases = INBOUND_CONTRACT_CASES.filter((item) => item.fixture === fixture.path);
  const expected = new Set(ir.inboundOperations.map((operation) => operation.name));
  const actual = new Set(cases.map((item) => item.operation));
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${fixture.path} inbound contract cases`);
  for (const item of cases) assert.equal(item.version, fixture.version);
}

function responseFixture(response: UpstreamResponseCase): Response {
  if (response.codec === 'empty') return new Response(null, { status: Number(response.status) });
  if (response.codec === 'binary') {
    return new Response(new Uint8Array(response.bodyBytes ?? []), {
      status: Number(response.status),
      headers: { 'content-type': response.contentType ?? 'application/octet-stream' },
    });
  }
  return new Response(JSON.stringify(response.body), {
    status: Number(response.status),
    headers: { 'content-type': response.contentType ?? 'application/json' },
  });
}

function operationResponse(
  operation: ReturnType<typeof normalizeDocument>['operations'][number],
  response: UpstreamResponseCase,
): ReturnType<typeof normalizeDocument>['operations'][number]['responses'][number] {
  const declared = operation.responses.find((candidate) => candidate.status === response.status);
  assert.ok(declared, `${operation.name} declares response ${response.status}`);
  const media = declared.content.find((candidate) => candidate.contentType === response.contentType);
  if (response.contentType === null) assert.equal(declared.content.length, 0, `${operation.name} empty response`);
  else assert.ok(media, `${operation.name} declares ${response.contentType}`);
  return declared;
}

function inputSection(item: UpstreamOperationCase, name: string): Record<string, unknown> {
  const value = item.input[name];
  return isRecord(value) ? value : {};
}

function assertRequestInputs(
  requestUrl: URL,
  requestHeaders: Headers,
  requestBody: BodyInit | null | undefined,
  operation: ReturnType<typeof normalizeDocument>['operations'][number],
  item: UpstreamOperationCase,
): void {
  let expectedPath = operation.route;
  for (const [name, value] of Object.entries(inputSection(item, 'path'))) {
    const marker = `{${name}}`;
    assert.equal(expectedPath.includes(marker), true, `${item.id} path input ${name}`);
    expectedPath = expectedPath.replace(marker, encodeURIComponent(String(value)));
  }
  assert.equal(requestUrl.pathname, expectedPath, `${item.id} path`);

  for (const [name, value] of Object.entries(inputSection(item, 'query'))) {
    if (Array.isArray(value)) {
      assert.deepEqual(requestUrl.searchParams.getAll(name), value.map(String), `${item.id} query ${name}`);
      continue;
    }
    if (isRecord(value)) {
      for (const [nestedName, nestedValue] of Object.entries(value)) {
        assert.equal(
          requestUrl.searchParams.get(`${name}[${nestedName}]`),
          String(nestedValue),
          `${item.id} query ${name}[${nestedName}]`,
        );
      }
      continue;
    }
    assert.equal(requestUrl.searchParams.get(name), String(value), `${item.id} query ${name}`);
  }

  for (const [name, value] of Object.entries(inputSection(item, 'header'))) {
    assert.equal(requestHeaders.get(name), String(value), `${item.id} header ${name}`);
  }

  const body = inputSection(item, 'body');
  if (item.requestCodec === 'json') {
    assert.equal(typeof requestBody, 'string', `${item.id} JSON request body`);
    if (typeof requestBody === 'string') {
      assert.deepEqual(JSON.parse(requestBody) as unknown, body, `${item.id} JSON request body`);
    }
  }
  if (item.requestCodec === 'form') {
    const expected = new URLSearchParams();
    for (const [name, value] of Object.entries(body)) {
      if (Array.isArray(value)) {
        for (const entry of value) expected.append(name, String(entry));
      } else {
        expected.append(name, String(value));
      }
    }
    assert.equal(String(requestBody), expected.toString(), `${item.id} form request body`);
  }
}

function authForDocument(document: unknown): Record<string, unknown> {
  const components = isRecord(document) && isRecord(document.components) ? document.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  return Object.fromEntries(Object.entries(schemes).map(([name, rawScheme]) => {
    const scheme = isRecord(rawScheme) ? rawScheme : {};
    const schemeType = String(scheme.type ?? '').toLowerCase();
    return [name, schemeType === 'http' && String(scheme.scheme ?? '').toLowerCase() === 'basic'
      ? { username: 'fixture', password: 'fixture' }
      : 'fixture'];
  }));
}

function requiresMutualTls(document: unknown): boolean {
  const components = isRecord(document) && isRecord(document.components) ? document.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  return Object.values(schemes).some((rawScheme) => isRecord(rawScheme) && rawScheme.type === 'mutualTLS');
}

function generatedClientModule(output: string, name: string): Promise<GeneratedOperationModule> {
  return import(pathToFileURL(path.join(output, 'dist', 'client.js')).href)
    .then((module) => requireRecord(module, `${name} generated client`));
}

async function executeCase(
  output: string,
  clientName: string,
  document: unknown,
  ir: ReturnType<typeof normalizeDocument>,
  item: UpstreamOperationCase,
  assertRequestValidation: boolean,
): Promise<void> {
  const module = await generatedClientModule(output, clientName);
  const Client = module[`${clientName}Client`];
  assert.equal(isGeneratedClientClass(Client), true, `${item.id} generated client class`);
  if (!isGeneratedClientClass(Client)) throw new TypeError(`${clientName}Client`);
  const operation = ir.operations.find((candidate) => candidate.name === item.operation);
  assert.ok(operation, `${item.id} normalized operation`);
  if (!operation) return;
  const declaredResponse = operationResponse(operation, item.response);
  assert.equal(declaredResponse.status, item.response.status);
  let captured: { url: string; init: RequestInit } | undefined;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured = { url: String(url), init: init ?? {} };
    return responseFixture(item.response);
  };
  const options: Record<string, unknown> = {
    baseUrl: 'https://upstream.example',
    auth: authForDocument(document),
  };
  if (requiresMutualTls(document)) options.mutualTls = { fetchImpl };
  else options.fetchImpl = fetchImpl;
  const client = new Client(options);
  const method = client[item.operation];
  assert.equal(typeof method, 'function', `${item.id} generated method`);
  if (typeof method !== 'function') return;
  const api = method.call(client);
  const result = await api.execute(item.input);
  assert.ok(captured, `${item.id} made a request`);
  if (!captured) return;
  assert.equal(captured.init.method, operation.method, `${item.id} method`);
  const requestUrl = new URL(captured.url);
  assert.equal(requestUrl.origin, 'https://upstream.example', `${item.id} origin`);
  assert.equal(captured.url.includes('{'), false, `${item.id} unresolved path marker`);
  assert.equal(result.status, Number(item.response.status), `${item.id} response status`);
  const requestHeaders = new Headers(captured.init.headers);
  if (item.requestCodec === 'json') {
    assert.match(String(requestHeaders.get('content-type')), /application\/json/);
  }
  if (item.requestCodec === 'form') {
    assert.match(String(requestHeaders.get('content-type')), /application\/x-www-form-urlencoded/);
  }
  assertRequestInputs(requestUrl, requestHeaders, captured.init.body, operation, item);
  if (item.response.codec === 'json') {
    assert.deepEqual(result.body, item.response.body, `${item.id} native JSON response body`);
  }
  if (item.response.codec === 'binary') {
    assert.ok(result.body instanceof Blob, `${item.id} native binary body`);
    assert.deepEqual([...new Uint8Array(await (result.body as Blob).arrayBuffer())], item.response.bodyBytes);
  }
  if (assertRequestValidation) {
    const requestBeforeInvalidInput = captured;
    await assert.rejects(
      () => api.execute(null),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation && error.issues.some(issue => issue.source === IssueSource.OpenAPI),
      `${item.id} uses the generated request validator`,
    );
    assert.equal(captured, requestBeforeInvalidInput, `${item.id} invalid input did not reach fetch`);
  }
}

function assertManifestProfile(output: string, profile: { readonly mobx: boolean; readonly validation: boolean }): void {
  const manifestValue: unknown = JSON.parse(fs.readFileSync(path.join(output, 'model-manifest.json'), 'utf8'));
  assert.ok(isRecord(manifestValue));
  const manifestProfile = manifestValue && Reflect.get(manifestValue, 'profile');
  assert.deepEqual(manifestProfile, { ...profile, allowAny: false, unknownFormats: 'warn' });
}

test('typed upstream corpus cases generate, strict-compile, and execute every accounted outbound operation', async t => {
  assertCaseTableIntegrity();
  assert.deepEqual(
    [...new Set(manifest.fixtures.map(({ version }) => version))].sort(),
    ['3.1', '3.2'],
  );
  for (const source of manifest.sources) {
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.ok(fs.existsSync(path.join(fixtureRoot, source.licenseFile)));
  }

  const outputRoot = createFixtureProject(t, 'golem-openapi-upstream-');
  let expectedOutboundOperations = 0;
  for (const [fixtureIndex, fixture] of manifest.fixtures.entries()) {
    const filename = path.join(fixtureRoot, fixture.path);
    assert.ok(fs.existsSync(filename), `missing vendored fixture: ${fixture.path}`);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
      fixture.sha256,
      `vendored fixture differs from pinned upstream bytes: ${fixture.path}`,
    );
    const document = await loadValidatedDocument(filename, {});
    const openapi = isRecord(document) ? document.openapi : undefined;
    assert.match(String(openapi), new RegExp(`^${fixture.version.replace('.', '\\.')}(?:\\.|$)`));
    const ir = normalizeDocument(document);
    const cases = assertOperationCaseCoverage(fixture, ir);
    assertInboundCaseCoverage(fixture, ir);
    expectedOutboundOperations += ir.operations.length;

    for (const profileId of PROFILE_IDS) {
      const profile = GENERATION_PROFILES[profileId];
      const output = path.join(outputRoot, `${fixture.version.replace('.', '-')}-${fixtureIndex}-${profileId}`);
      // MobX needs the golem mode: the helper generates that SDK and runs the models job for its codecs.
      const result = await generateMaterializedSdk(document, {
        output,
        name: `Upstream${fixtureIndex}`,
        // Third-party documents carry formats golem does not check, such as the uspto `uriref`.
        profile: { ...profile, unknownFormats: 'warn' },
      });
      assertArtifactInventory(result, ir);
      compileStrict(output);
      assertManifestProfile(output, profile);

      const linksArtifact = result.artifacts.find(({ path: filename }) => filename.endsWith('/links.ts'))?.content;
      if (linksArtifact?.includes('"operationId": "getRepositoriesByOwner"')) {
        const linksModule = requireRecord(
          await import(pathToFileURL(path.join(output, 'dist/links.js')).href),
          'response Link Objects module',
        );
        const responseLinks = requireRecord(linksModule.responseLinks, 'responseLinks');
        const getUserByName = requireRecord(responseLinks.getUserByName, 'getUserByName links');
        const status200 = requireRecord(getUserByName['200'], 'getUserByName 200 links');
        assert.deepEqual(status200.userRepositories, {
          operationId: 'getRepositoriesByOwner',
          parameters: { username: '$response.body#/username' },
        }, 'the userRepositories link carries its target operation and runtime expression parameter');
      }

      // Every profile must execute every accounted outbound operation.  Type
      // and artifact checks alone cannot prove that profile-specific client
      // composition, codecs, and validation seams work on the wire.
      const selected = cases;
      for (const item of selected) {
        await executeCase(
          output,
          `Upstream${fixtureIndex}`,
          document,
          ir,
          item,
          profile.validation && item.operation === selected[0]?.operation,
        );
      }
    }
  }

  assert.equal(expectedOutboundOperations, UPSTREAM_OPERATION_CASES.length);
});
