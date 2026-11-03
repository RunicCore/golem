import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { GolemConfig, GolemJob } from '#golem/config';
import { applyJob, loadInventory } from '#golem/outputs';
import { generate } from '#openapi/generator';
import type { OpenApiGenerationResult } from '#openapi/generator';
import type { OpenApiGenerationProfile } from './openapi/helpers.js';
import { repoRoot, tscBin } from './openapi/helpers.js';
import { snapshotFilesystem } from './fixture-project.js';
import { configFor, jobWithFacts } from './support/output-config.js';

interface OpenApiFixture {
  readonly root: string;
  readonly input: string;
  readonly output: string;
  readonly config: GolemConfig;
  readonly job: GolemJob;
  readonly options: Parameters<typeof generate>[0];
}

const profile = (validation: boolean): OpenApiGenerationProfile => ({ validation });

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-artifact-retirement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'api.json');
  const output = path.join(root, 'sdk');
  fs.writeFileSync(input, `${JSON.stringify(document, null, 2)}\n`);
  const job = jobWithFacts('openapi:sdk', '@exprtlabs/golem-openapi-ts', { outputs: [{ path: output, kind: 'folder' }] });
  const config: GolemConfig = { ...configFor(root, job), profile: generationProfile };
  return { root, input, output, config, job, options: { input, output, name: 'Retirement', profile: generationProfile } };
}

async function generateArtifacts(fixtureValue: OpenApiFixture): Promise<OpenApiGenerationResult> {
  return generate({ ...fixtureValue.options });
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
  const packageDirectory = path.join(fixtureValue.output, 'node_modules/@exprtlabs/golem');
  fs.mkdirSync(path.dirname(packageDirectory), { recursive: true });
  if (!fs.existsSync(packageDirectory)) {
    fs.symlinkSync(path.join(repoRoot(), 'packages/golem'), packageDirectory, 'dir');
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
  return result;
}

async function checkThenApply(
  fixtureValue: OpenApiFixture,
  result: OpenApiGenerationResult,
): Promise<void> {
  const before = snapshotFilesystem(fixtureValue.root);
  assert.throws(
    () => applyJob(fixtureValue.config, loadInventory(fixtureValue.config), fixtureValue.job, result.artifacts, true),
    /Generated outputs are stale for \S+:\n/,
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

test('retiring the last OpenAPI component removes schema artifacts through public generation and applyJob', async (t: TestContext) => {
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
  const inputSchemas = artifactPath(initial, 'input-schemas.ts');
  const outputSchemas = artifactPath(initial, 'output-schemas.ts');
  assert.equal(fs.existsSync(inputSchemas), true);
  assert.equal(fs.existsSync(outputSchemas), true);

  writeDocument(fixtureValue, nextDocument);
  const next = await generateArtifacts(fixtureValue);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/input-schemas.ts')), false);
  assert.equal(next.artifacts.some(({ path: filename }) => filename.endsWith('/output-schemas.ts')), false);
  await checkThenApply(fixtureValue, next);
  assert.equal(fs.existsSync(inputSchemas), false);
  assert.equal(fs.existsSync(outputSchemas), false);
  assert.equal(loadInventory(fixtureValue.config).files['sdk/input-schemas.ts'], undefined);
  assert.equal(loadInventory(fixtureValue.config).files['sdk/output-schemas.ts'], undefined);
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
