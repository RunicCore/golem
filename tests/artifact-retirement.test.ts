import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CodegenConfig, CodegenJob } from '#codegen/config';
import { applyJob, loadInventory } from '#codegen/outputs';
import { generate } from '#openapi/generator';
import type { OpenApiGenerationProfile, OpenApiGenerationResult } from '#openapi/generator';
import { repoRoot, tscBin } from './openapi/helpers.js';
import { snapshotFilesystem } from './fixture-project.js';

type OpenApiJob = Extract<CodegenJob, { kind: 'openapi' }>;

interface OpenApiFixture {
  readonly root: string;
  readonly input: string;
  readonly output: string;
  readonly config: CodegenConfig;
  readonly job: OpenApiJob;
}

const profile = (validation: boolean): OpenApiGenerationProfile => ({ mobx: false, validation });

function metadata(title: string): Record<string, unknown> {
  return { openapi: '3.1.0', info: { title, version: '1' } };
}

function modelSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  };
}

function healthOperation(): Record<string, unknown> {
  return {
    operationId: 'health',
    responses: { '204': { description: 'healthy' } },
  };
}

function fixture(
  t: TestContext,
  document: Record<string, unknown>,
  generationProfile: OpenApiGenerationProfile = profile(true),
): OpenApiFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runic-artifact-retirement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'api.json');
  const output = path.join(root, 'sdk');
  fs.writeFileSync(input, `${JSON.stringify(document, null, 2)}\n`);
  const job: OpenApiJob = {
    id: 'openapi:sdk',
    kind: 'openapi',
    package: '@exprtlabs/openapi-to-ts',
    options: { input, output, name: 'Retirement', profile: generationProfile },
  };
  const config: CodegenConfig = {
    directory: root,
    configFile: path.join(root, 'runic-codegen.yaml'),
    inventoryFile: path.join(root, '.runic-codegen/outputs.json'),
    profile: generationProfile,
    jobs: [job],
  };
  return { root, input, output, config, job };
}

async function generateArtifacts(fixtureValue: OpenApiFixture): Promise<OpenApiGenerationResult> {
  return generate({ ...fixtureValue.job.options });
}

function compileGeneratedSdk(fixtureValue: OpenApiFixture): void {
  const packageManifest = path.join(fixtureValue.output, 'package.json');
  if (!fs.existsSync(packageManifest)) {
    fs.writeFileSync(packageManifest, JSON.stringify({
      name: 'generated-sdk-consumer',
      private: true,
      type: 'module',
    }));
  }
  const packageDirectory = path.join(fixtureValue.output, 'node_modules/@exprtlabs/codegen');
  fs.mkdirSync(path.dirname(packageDirectory), { recursive: true });
  if (!fs.existsSync(packageDirectory)) {
    fs.symlinkSync(path.join(repoRoot(), 'packages/codegen'), packageDirectory, 'dir');
  }

  const consumerDirectory = path.join(fixtureValue.root, '.generated-sdk-consumer');
  fs.mkdirSync(consumerDirectory, { recursive: true });
  const tsconfig = path.join(consumerDirectory, 'tsconfig.json');
  if (!fs.existsSync(tsconfig)) {
    fs.writeFileSync(tsconfig, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['../sdk/**/*.ts'],
    }, null, 2));
  }
  const compiled = spawnSync(process.execPath, [tscBin(), '-p', tsconfig], {
    cwd: consumerDirectory,
    encoding: 'utf8',
  });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout || 'generated SDK consumer compilation failed');
}

function artifactPath(result: OpenApiGenerationResult, basename: string): string {
  const artifact = result.artifacts.find(({ path: filename }) => filename.endsWith(`/${basename}`));
  assert.ok(artifact, `expected generated ${basename}`);
  return artifact.path;
}

async function applyInitial(fixtureValue: OpenApiFixture): Promise<OpenApiGenerationResult> {
  const result = await generateArtifacts(fixtureValue);
  applyJob(fixtureValue.config, loadInventory(fixtureValue.config), fixtureValue.job, result.artifacts);
  compileGeneratedSdk(fixtureValue);
  return result;
}

async function checkThenApply(
  fixtureValue: OpenApiFixture,
  result: OpenApiGenerationResult,
): Promise<void> {
  const before = snapshotFilesystem(fixtureValue.root);
  assert.throws(
    () => applyJob(fixtureValue.config, loadInventory(fixtureValue.config), fixtureValue.job, result.artifacts, true),
    /stale/,
  );
  assert.deepEqual(snapshotFilesystem(fixtureValue.root), before);
  applyJob(fixtureValue.config, loadInventory(fixtureValue.config), fixtureValue.job, result.artifacts);
  const afterApply = snapshotFilesystem(fixtureValue.root);
  assert.doesNotThrow(() => applyJob(
    fixtureValue.config,
    loadInventory(fixtureValue.config),
    fixtureValue.job,
    result.artifacts,
    true,
  ));
  assert.deepEqual(snapshotFilesystem(fixtureValue.root), afterApply);
  compileGeneratedSdk(fixtureValue);
}

function writeDocument(fixtureValue: OpenApiFixture, document: Record<string, unknown>): void {
  fs.writeFileSync(fixtureValue.input, `${JSON.stringify(document, null, 2)}\n`);
}

function withProfile(
  fixtureValue: OpenApiFixture,
  generationProfile: OpenApiGenerationProfile,
): OpenApiFixture {
  const job: OpenApiJob = {
    ...fixtureValue.job,
    options: { ...fixtureValue.job.options, profile: generationProfile },
  };
  return {
    ...fixtureValue,
    config: { ...fixtureValue.config, profile: generationProfile, jobs: [job] },
    job,
  };
}

test('retiring the last OpenAPI operation removes the client artifact through public generation and applyJob', async (t: TestContext) => {
  const initialDocument = {
    ...metadata('LastOperation'),
    paths: { '/health': { get: healthOperation() } },
    components: { schemas: { Retained: { type: 'string' } } },
  };
  const nextDocument = {
    ...metadata('LastOperation'),
    components: { schemas: { Retained: { type: 'string' } } },
  };
  const fixtureValue = fixture(t, initialDocument);
  const initial = await applyInitial(fixtureValue);
  const client = artifactPath(initial, 'client.ts');
  assert.equal(fs.existsSync(client), true);

  writeDocument(fixtureValue, nextDocument);
  const next = await generateArtifacts(fixtureValue);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/client.ts')), false);
  await checkThenApply(fixtureValue, next);
  assert.equal(fs.existsSync(client), false);
  assert.equal(loadInventory(fixtureValue.config).files['sdk/client.ts'], undefined);
});

test('retiring the last OpenAPI component removes model artifacts through public generation and applyJob', async (t: TestContext) => {
  const initialDocument = {
    ...metadata('LastComponent'),
    paths: {
      '/orders': {
        get: {
          operationId: 'getOrder',
          responses: {
            '200': {
              description: 'order',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
            },
          },
        },
      },
    },
    components: { schemas: { Order: modelSchema() } },
  };
  const nextDocument = {
    ...metadata('LastComponent'),
    paths: { '/orders': { get: healthOperation() } },
  };
  const fixtureValue = fixture(t, initialDocument);
  const initial = await applyInitial(fixtureValue);
  const models = artifactPath(initial, 'models.ts');
  const inputSchemas = artifactPath(initial, 'input-schemas.ts');
  const outputSchemas = artifactPath(initial, 'output-schemas.ts');
  assert.equal(fs.existsSync(models), true);
  assert.equal(fs.existsSync(inputSchemas), true);
  assert.equal(fs.existsSync(outputSchemas), true);

  writeDocument(fixtureValue, nextDocument);
  const next = await generateArtifacts(fixtureValue);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/models.ts')), false);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/input-schemas.ts')), false);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/output-schemas.ts')), false);
  await checkThenApply(fixtureValue, next);
  assert.equal(fs.existsSync(models), false);
  assert.equal(fs.existsSync(inputSchemas), false);
  assert.equal(fs.existsSync(outputSchemas), false);
  assert.equal(loadInventory(fixtureValue.config).files['sdk/models.ts'], undefined);
  assert.equal(loadInventory(fixtureValue.config).files['sdk/input-schemas.ts'], undefined);
  assert.equal(loadInventory(fixtureValue.config).files['sdk/output-schemas.ts'], undefined);
});

test('retiring the last inbound operation removes inbound.ts through public generation and applyJob', async (t: TestContext) => {
  const initialDocument = {
    ...metadata('LastInbound'),
    paths: { '/health': { get: healthOperation() } },
    webhooks: {
      orderChanged: {
        post: {
          operationId: 'orderChanged',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          responses: { '204': { description: 'accepted' } },
        },
      },
    },
    components: { schemas: { Order: modelSchema() } },
  };
  const nextDocument = {
    ...metadata('LastInbound'),
    paths: { '/health': { get: healthOperation() } },
    components: { schemas: { Order: modelSchema() } },
  };
  const fixtureValue = fixture(t, initialDocument);
  const initial = await applyInitial(fixtureValue);
  const inbound = artifactPath(initial, 'inbound.ts');
  assert.equal(fs.existsSync(inbound), true);

  writeDocument(fixtureValue, nextDocument);
  const next = await generateArtifacts(fixtureValue);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/inbound.ts')), false);
  await checkThenApply(fixtureValue, next);
  assert.equal(fs.existsSync(inbound), false);
  assert.equal(loadInventory(fixtureValue.config).files['sdk/inbound.ts'], undefined);
});

test('retiring the last response link removes links.ts through public generation and applyJob', async (t: TestContext) => {
  const initialDocument = {
    ...metadata('LastLink'),
    paths: {
      '/orders': {
        get: {
          operationId: 'getOrder',
          responses: {
            '200': {
              description: 'order',
              links: { self: { operationId: 'getOrder' } },
            },
          },
        },
      },
    },
  };
  const nextDocument = {
    ...metadata('LastLink'),
    paths: { '/orders': { get: healthOperation() } },
  };
  const fixtureValue = fixture(t, initialDocument);
  const initial = await applyInitial(fixtureValue);
  const links = artifactPath(initial, 'links.ts');
  assert.equal(fs.existsSync(links), true);

  writeDocument(fixtureValue, nextDocument);
  const next = await generateArtifacts(fixtureValue);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/links.ts')), false);
  await checkThenApply(fixtureValue, next);
  assert.equal(fs.existsSync(links), false);
  assert.equal(loadInventory(fixtureValue.config).files['sdk/links.ts'], undefined);
});

test('turning validation off retires validation.ts through public generation and applyJob', async (t: TestContext) => {
  const document = {
    ...metadata('ValidationTransition'),
    paths: { '/health': { get: healthOperation() } },
  };
  const validationOn = fixture(t, document, profile(true));
  const initial = await applyInitial(validationOn);
  const validation = artifactPath(initial, 'validation.ts');
  assert.equal(fs.existsSync(validation), true);

  const validationOff = withProfile(validationOn, profile(false));
  const next = await generateArtifacts(validationOff);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/validation.ts')), false);
  await checkThenApply(validationOff, next);
  assert.equal(fs.existsSync(validation), false);
  assert.equal(loadInventory(validationOff.config).files['sdk/validation.ts'], undefined);
});

