import { readFixture } from '../fixture-project.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { runPipeline } from '#golem/cli';
import { workspace } from '../support/process.js';
import { readGeneratedClientSource } from '../openapi/helpers.js';
import { until } from '../support/watch-wait.js';
import { createControllerFixture } from '../fixture-templates/controllers/project.js';

interface RealFixture {
  readonly root: string;
  readonly config: string;
  readonly helper: string;
  readonly controller: string;
  readonly document: string;
  readonly sdkClient: string;
  readonly modelCompanion: string;
}

interface WatchCapture {
  readonly child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly paths: Readonly<Record<string, unknown>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readDocument(filename: string): OpenApiDocument {
  const value: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!record(value) || typeof value.openapi !== 'string' || !record(value.paths)) {
    throw new Error(`Invalid OpenAPI fixture output: ${filename}`);
  }
  return { openapi: value.openapi, paths: value.paths };
}

function hasOperation(document: OpenApiDocument, route: string, method: string): boolean {
  const pathItem = document.paths[route];
  return record(pathItem) && record(pathItem[method]);
}

function fixture(t: TestContext): RealFixture {
  const root = createControllerFixture(t, {
    prefix: 'golem-ts-openapi-watch-',
    packageName: 'golem-ts-openapi-watch-fixture',
    links: 'workspace',
    tsconfig: {
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    },
    files: {
      'golem.yaml': readFixture('controllers/watch/project/golem.yaml'),
      'src/route-helper.ts': readFixture('controllers/watch/project/route-helper.ts'),
      'src/catalog.controller.ts': readFixture('controllers/watch/project/controller.ts'),
      'src/cart.model.ts': readFixture('controllers/watch/project/cart.model.ts'),
    },
  });
  const helper = path.join(root, 'src/route-helper.ts');
  const controller = path.join(root, 'src/catalog.controller.ts');
  const config = path.join(root, 'golem.yaml');

  return {
    root,
    config,
    helper,
    controller,
    document: path.join(root, 'generated/openapi.json'),
    sdkClient: path.join(root, 'sdk/client.ts'),
    modelCompanion: path.join(root, 'src/cart.model.generated.ts'),
  };
}

function startWatch(fixture: RealFixture): WatchCapture {
  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const child = spawn(process.execPath, [binary, 'watch', '--config', fixture.config], {
    cwd: fixture.root,
    env: { ...process.env, NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (value: Buffer) => { stdout += value.toString(); });
  child.stderr?.on('data', (value: Buffer) => { stderr += value.toString(); });
  return {
    child,
    get stdout(): string { return stdout; },
    get stderr(): string { return stderr; },
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.kill('SIGTERM');
  });
}

function successCount(stdout: string): number {
  return (stdout.match(/Generated configured outputs\./g) ?? []).length;
}

test('real Nest watch follows helper dependencies through OpenAPI, SDK, and models and recovers after controller errors', async (t: TestContext) => {
  const fixtureData = fixture(t);
  const watch = startWatch(fixtureData);
  try {
    await until(
      () => successCount(watch.stdout) >= 1
        && fs.existsSync(fixtureData.document)
        && fs.existsSync(fixtureData.sdkClient)
        && fs.existsSync(fixtureData.modelCompanion)
        && hasOperation(readDocument(fixtureData.document), '/api/catalog/items/list', 'get'),
      `initial real controller -> document -> SDK -> model generation (stderr=${watch.stderr})`,
    );
    assert.equal(watch.stderr, '', 'valid real Nest generation should not report diagnostics');
    const initialSuccesses = successCount(watch.stdout);
    const initialModel = fs.readFileSync(fixtureData.modelCompanion, 'utf8');
    assert.match(initialModel, /route: "items"/);

    fs.writeFileSync(fixtureData.helper, fs.readFileSync(fixtureData.helper, 'utf8').replace("'items'", "'things'"));
    await until(
      () => successCount(watch.stdout) > initialSuccesses
        && hasOperation(readDocument(fixtureData.document), '/api/catalog/things/list', 'get')
        && readGeneratedClientSource(path.dirname(fixtureData.sdkClient)).includes('/api/catalog/things/list')
        && fs.readFileSync(fixtureData.modelCompanion, 'utf8').includes('route: "things"'),
      `helper dependency invalidation (stdout=${watch.stdout}, stderr=${watch.stderr})`,
    );
    const helperSuccesses = successCount(watch.stdout);
    assert.equal(watch.stderr, '', 'helper edit should remain a valid generation');

    const stableDocument = fs.readFileSync(fixtureData.document, 'utf8');
    const stableSdk = readGeneratedClientSource(path.dirname(fixtureData.sdkClient));
    const validController = fs.readFileSync(fixtureData.controller, 'utf8');
    const invalidController = validController.replace(
      /\n}\s*$/,
      "\n  @Get(routeFor('list'))\n  duplicate(): void {}\n}\n",
    );
    fs.writeFileSync(fixtureData.controller, invalidController);
    await until(
      () => watch.stderr.includes('NEST1306'),
      `duplicate route diagnostic (stdout=${watch.stdout}, stderr=${watch.stderr})`,
    );
    const errorsAfterInvalidController = watch.stderr;
    // The invalid edit is the observation point for the helper run: an output-triggered run would precede it.
    assert.equal(successCount(watch.stdout), helperSuccesses, 'no output-triggered run after the helper edit, and the failed upstream generation publishes nothing downstream');
    assert.equal(fs.readFileSync(fixtureData.document, 'utf8'), stableDocument, 'failed controller must preserve the last document');
    assert.equal(readGeneratedClientSource(path.dirname(fixtureData.sdkClient)), stableSdk, 'failed controller must preserve the last SDK');

    fs.writeFileSync(fixtureData.controller, validController);
    await until(
      () => successCount(watch.stdout) > helperSuccesses
        && hasOperation(readDocument(fixtureData.document), '/api/catalog/things/list', 'get')
        && fs.readFileSync(fixtureData.modelCompanion, 'utf8').includes('route: "things"'),
      `controller correction recovery (stdout=${watch.stdout}, stderr=${watch.stderr})`,
    );
    const recoveredSuccesses = successCount(watch.stdout);
    // The correction is the observation point for the failure: a retry loop would report again before it lands.
    assert.equal(watch.stderr, errorsAfterInvalidController, 'controller failure must not retry in a loop');
    assert.equal(recoveredSuccesses, helperSuccesses + 1, 'controller correction runs once');
    assert.equal(fs.readFileSync(fixtureData.document, 'utf8'), stableDocument, 'recovery should restore the stable document');
    assert.equal(readGeneratedClientSource(path.dirname(fixtureData.sdkClient)), stableSdk, 'recovery should restore the stable SDK');

    const ignored = path.join(fixtureData.root, 'src/health.controllers.ts');
    const discovered = path.join(fixtureData.root, 'src/health.controller.ts');
    fs.writeFileSync(ignored, `import { Controller, Get } from '@nestjs/common';
@Controller('health') export class HealthController {
  @Get() read(): { ok: boolean } { return { ok: true }; }
}`);
    // A controller edit is the observation point: it runs once, and the plural file stays undiscovered.
    fs.writeFileSync(fixtureData.controller, `${validController}\n// probe\n`);
    await until(() => successCount(watch.stdout) > recoveredSuccesses, `probe regeneration (stderr=${watch.stderr})`);
    assert.equal(successCount(watch.stdout), recoveredSuccesses + 1, 'recovered watch must not loop');
    assert.equal(hasOperation(readDocument(fixtureData.document), '/api/health', 'get'), false, 'plural filenames are outside default controller discovery');
    fs.renameSync(ignored, discovered);
    await until(() => hasOperation(readDocument(fixtureData.document), '/api/health', 'get')
      && readGeneratedClientSource(path.dirname(fixtureData.sdkClient)).includes('/api/health'), 'new controller discovery');
    fs.unlinkSync(discovered);
    await until(() => !hasOperation(readDocument(fixtureData.document), '/api/health', 'get')
      && !readGeneratedClientSource(path.dirname(fixtureData.sdkClient)).includes('/api/health'), 'deleted controller discovery');
  } finally {
    await stopChild(watch.child);
  }
});

test('check stops at stale controller output before running downstream SDK and model jobs', async (t: TestContext) => {
  const fixtureData = fixture(t);
  await runPipeline(fixtureData.config);
  const sdkBefore = readGeneratedClientSource(path.dirname(fixtureData.sdkClient));
  const modelBefore = fs.readFileSync(fixtureData.modelCompanion, 'utf8');
  const sdkMtimeBefore = fs.statSync(fixtureData.sdkClient, { bigint: true }).mtimeNs;
  const modelMtimeBefore = fs.statSync(fixtureData.modelCompanion, { bigint: true }).mtimeNs;

  fs.appendFileSync(fixtureData.document, '\n');
  await assert.rejects(
    runPipeline(fixtureData.config, { check: true }),
    (error: unknown) => String(error).includes('Generated outputs are stale for controllers:')
      && String(error).includes('generated/openapi.json'),
  );
  assert.equal(readGeneratedClientSource(path.dirname(fixtureData.sdkClient)), sdkBefore, 'upstream check failure must leave the SDK untouched');
  assert.equal(fs.readFileSync(fixtureData.modelCompanion, 'utf8'), modelBefore, 'upstream check failure must leave models untouched');
  assert.equal(fs.statSync(fixtureData.sdkClient, { bigint: true }).mtimeNs, sdkMtimeBefore);
  assert.equal(fs.statSync(fixtureData.modelCompanion, { bigint: true }).mtimeNs, modelMtimeBefore);
});
