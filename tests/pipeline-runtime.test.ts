import { copyFixtureFile, createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, type TestContext } from 'node:test';

import { runPipeline, watchPipeline } from '#golem/cli';
import { generate as generateOpenApi } from '#openapi/generator';
import { workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';
import { compileGeneratedSdk } from './openapi/helpers.js';

interface CombinedFixture {
  readonly root: string;
  readonly config: string;
}

interface ModelWatchFixture {
  readonly root: string;
  readonly config: string;
  readonly manifest: string;
  readonly companion: string;
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function linkPackages(root: string, names: readonly string[]): void {
  linkProjectPackages(root, Object.fromEntries(
    names.map(name => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
}

function workspaceReleaseVersion(): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(workspace, 'packages/golem/package.json'), 'utf8')) as { version: string };
  return version;
}

function installFakeOpenApiProvider(root: string, manifest: unknown): void {
  const packageRoot = path.join(root, 'node_modules/@exprtlabs/golem-openapi');
  fs.rmSync(packageRoot, { recursive: true, force: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@exprtlabs/golem-openapi',
    version: workspaceReleaseVersion(),
    type: 'module',
    exports: { './generator': './generator.js' },
  }));
  copyFixtureFile(packageRoot, 'pipeline/returned-manifest-provider/generator.js', 'generator.js');
  fs.writeFileSync(path.join(packageRoot, 'fixture-manifest.json'), JSON.stringify(manifest));
}

function combinedFixture(t: TestContext): CombinedFixture {
  const root = createFixtureProject(t, 'golem-pipeline-runtime-');

  linkPackages(root, ['golem', 'golem-model', 'golem-openapi']);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'pipeline-runtime-fixture', private: true, type: 'module' }),
  );
  writeFixture(root, { mobx: false, validation: true });
  const config = path.join(root, 'golem.yaml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(
    'validation: true\n',
    'validation: true\nallowAny: false\n',
  ));
  return { root, config };
}

function modelWatchFixture(t: TestContext): ModelWatchFixture {
  const root = createFixtureProject(t, 'golem-model-watch-');

  linkPackages(root, ['golem', 'golem-model']);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'model-watch-fixture', private: true, type: 'module' }),
  );
  fs.mkdirSync(path.join(root, 'src/external'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        skipLibCheck: true,
        outDir: 'build',
        rootDir: 'src',
      },
      include: ['src/**/*.ts'],
    }),
  );
  fs.writeFileSync(
    path.join(root, 'golem.yaml'),
    'version: 1\nmobx: false\nvalidation: false\najvStandalone: false\nallowAny: false\nmodels:\n  root: .\n',
  );

  const manifest = path.join(root, 'src/external/model-manifest.json');
  copyFixtureFile(root, 'pipeline/model-watch/cart.model.ts', 'src/cart.model.ts');

  return {
    root,
    config: path.join(root, 'golem.yaml'),
    manifest,
    companion: path.join(root, 'src/cart.model.generated.ts'),
  };
}

function writeExternalManifest(fixture: ModelWatchFixture): void {
  copyFixtureFile(fixture.root, 'pipeline/model-watch/models.ts', 'src/external/models.ts');
  fs.writeFileSync(fixture.manifest, JSON.stringify({
    profile: { mobx: false, validation: false, ajvStandalone: false, allowAny: false },
    models: [{
      id: 'fixture:money',
      allowAny: false,
      type: { module: './types.ts', export: 'Money' },
      generated: { module: './models.ts', export: 'MoneyModel' },
    }],
  }));
}

function writeExternalTypes(fixture: ModelWatchFixture): void {
  copyFixtureFile(fixture.root, 'pipeline/model-watch/types.ts', 'src/external/types.ts');
}

function collisionDocument(schemaNames: readonly string[], includeLinks = false): Record<string, unknown> {
  const first = schemaNames[0];
  if (!first) throw new Error('At least one schema is required.');
  return {
    openapi: '3.1.0',
    info: { title: 'Payments', version: '1' },
    paths: {
      '/payments': {
        get: {
          operationId: 'listPayments',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: `#/components/schemas/${first}` } },
              },
              ...(includeLinks ? { links: { again: { operationId: 'listPayments' } } } : {}),
            },
          },
        },
      },
    },
    components: {
      schemas: Object.fromEntries(schemaNames.map((name) => [
        name,
        { type: 'object', properties: { status: { type: 'string' } } },
      ])),
    },
  };
}

async function generatedOpenApiFixture(
  t: TestContext,
  schemaNames: readonly string[],
  validation: boolean,
): Promise<string> {
  const root = createFixtureProject(t, 'golem-openapi-collision-');

  const input = path.join(root, 'api.json');
  const output = path.join(root, 'sdk');
  fs.writeFileSync(input, JSON.stringify(collisionDocument(schemaNames)));
  const result = await generateOpenApi({
    input,
    output,
    name: 'Payments',
    profile: { mobx: false, validation, ajvStandalone: false, allowAny: false },
  });
  writeGeneratedArtifacts(result.artifacts);
  fs.writeFileSync(path.join(output, 'package.json'), '{"type":"module"}');
  linkProjectPackages(output, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  return output;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function until(
  check: () => boolean,
  message: string,
  timeout = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${message}`);
}

function waitForClose(child: ChildProcess): Promise<ChildResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForCloseWithin(child: ChildProcess, message: string, timeout = 10_000): Promise<ChildResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForClose(child),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${message}`)), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForClose(child);
}

test('initial watch failure records a missing configured input and recovers on creation, and a config edit to another missing input recovers the same way', async (t: TestContext) => {
  const { root, config } = combinedFixture(t);
  const originalInput = path.join(root, 'api.json');
  const missingInput = path.join(root, 'missing-api.json');
  const originalDocument = fs.readFileSync(originalInput, 'utf8');
  fs.unlinkSync(originalInput);
  fs.writeFileSync(
    config,
    fs.readFileSync(config, 'utf8').replace('input: api.json', 'input: missing-api.json'),
  );

  const errors: string[] = [];
  const stop = watchPipeline(config, (error: unknown) => errors.push(errorText(error)));
  try {
    await until(() => errors.length > 0, 'initial watch failure for missing OpenAPI input');
    assert.match(errors[errors.length - 1] ?? '', /does not exist|OpenAPI input/);

    fs.writeFileSync(missingInput, originalDocument);
    await until(
      () => fs.existsSync(path.join(root, 'sdk/client.ts'))
        && fs.readFileSync(path.join(root, 'sdk/client.ts'), 'utf8').includes('getMoney'),
      `watch recovery after creating ${missingInput}`,
    );

    const recoveredErrorCount = errors.length;
    // The next source edit is the observation point: a retry loop would report errors before it lands.
    const source = path.join(root, 'src/cart.model.ts');
    const companion = path.join(root, 'src/cart.model.generated.ts');
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('note: string', 'note: string; probe?: string'));
    await until(() => fs.readFileSync(companion, 'utf8').includes('probe'), 'recovered watch regenerates the next edit');
    assert.equal(errors.length, recoveredErrorCount, 'recovered watch must not retry in a loop');

    // A config edit while the watch is running that points at another missing input is reported, then recovers on creation.
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('input: missing-api.json', 'input: next-api.json'));
    await until(
      () => errors.length > recoveredErrorCount && /does not exist|OpenAPI input/.test(errors[errors.length - 1] ?? ''),
      'watch reports the input that a config edit made missing',
    );
    fs.writeFileSync(path.join(root, 'next-api.json'), JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Next API', version: '2' },
      paths: { '/items': { get: { operationId: 'listItems', responses: { 200: { description: 'Items' } } } } },
    }));
    await until(
      () => fs.readFileSync(path.join(root, 'sdk/client.ts'), 'utf8').includes('listItems'),
      'watch recovery after creating the input a config edit referenced',
    );
  } finally {
    stop();
  }
});

test('initial model watch failures retain missing manifests and declarations in both save orders', async (t: TestContext) => {
  for (const order of ['manifest-first', 'declaration-first'] as const) {
    const fixture = modelWatchFixture(t);
    const errors: string[] = [];
    const stop = watchPipeline(fixture.config, (error: unknown) => errors.push(errorText(error)));
    try {
      await until(() => errors.length > 0, `${order}: initial missing manifest failure`);
      const initialErrorCount = errors.length;

      if (order === 'manifest-first') {
        writeExternalManifest(fixture);
        await until(
          () => errors.length > initialErrorCount
            && /types\.ts|TS2307|Cannot find module/.test(errors[errors.length - 1] ?? ''),
          `${order}: missing imported declaration failure after manifest creation`,
        );
        writeExternalTypes(fixture);
      } else {
        writeExternalTypes(fixture);
        await until(
          () => errors.length > initialErrorCount
            && /manifest|model-manifest/i.test(errors[errors.length - 1] ?? ''),
          `${order}: missing manifest failure after declaration creation`,
        );
        writeExternalManifest(fixture);
      }

      await until(
        () => fs.existsSync(fixture.companion)
          && fs.readFileSync(fixture.companion, 'utf8').includes('MoneyModel'),
        `${order}: model companion after external inputs are complete`,
      );
      const recoveredErrorCount = errors.length;
      // The next source edit is the observation point: a retry loop would report errors before it lands.
      const source = path.join(fixture.root, 'src/cart.model.ts');
      fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('{ money: Money }', '{ money: Money; probe?: string }'));
      await until(() => fs.readFileSync(fixture.companion, 'utf8').includes('probe'), `${order}: recovered watch regenerates the next edit (errors=${errors.slice(recoveredErrorCount).join(" | ")})`);
      assert.equal(errors.length, recoveredErrorCount, `${order}: recovered watch must not retry in a loop`);
    } finally {
      stop();
    }
  }
});

test('exec forwards SIGTERM and SIGINT to its child and preserves the signal result', async (t: TestContext) => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const { root, config } = combinedFixture(t);
    const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
    const ready = path.join(root, `${signal.toLowerCase()}.ready`);
    const received = path.join(root, `${signal.toLowerCase()}.received`);
    const childScript = copyFixtureFile(root, 'pipeline/signal-child/run.cjs', 'signal-child.cjs');
    const parent = spawn(process.execPath, [
      binary,
      'exec',
      '--config',
      config,
      '--',
      process.execPath,
      childScript,
      ready, received,
    ], {
      cwd: root,
      env: { ...process.env, NODE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await until(() => fs.existsSync(ready), `${signal}: exec child started`);
      assert.equal(parent.kill(signal), true, `${signal}: parent process should be running`);
      const result = await waitForClose(parent);
      assert.equal(result.signal, signal, `${signal}: parent should preserve child signal`);
      assert.equal(result.code, null, `${signal}: signal exit must not become a normal code`);
      assert.equal(fs.readFileSync(received, 'utf8'), signal, `${signal}: child must receive the signal`);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) await stopChild(parent);
    }
  }
});

test('exec --watch keeps its child alive through generation failure, recovers, and cleans up on signal', async (t: TestContext) => {
  const { root, config } = combinedFixture(t);
  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const ready = path.join(root, 'watch-child.ready');
  const received = path.join(root, 'watch-child.received');
  const heartbeat = path.join(root, 'watch-child.heartbeat');
  const childScript = copyFixtureFile(root, 'pipeline/watch-child/run.cjs', 'watch-child.cjs');
  const parent = spawn(process.execPath, [
    binary,
    'exec',
    '--watch',
    '--config',
    config,
    '--',
    process.execPath,
    childScript,
    ready, received, heartbeat,
  ], {
    cwd: root,
    env: { ...process.env, NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  parent.stdout?.on('data', (value: Buffer) => { stdout += value.toString(); });
  parent.stderr?.on('data', (value: Buffer) => { stderr += value.toString(); });
  const api = path.join(root, 'api.json');
  const initialDocument = fs.readFileSync(api, 'utf8');

  try {
    await until(() => stdout.includes('Generated configured outputs.') && fs.existsSync(ready), `exec --watch initial generation: ${stderr}`);

    fs.writeFileSync(api, JSON.stringify({ openapi: '2.0', info: {}, paths: {} }));
    await until(() => /OpenAPI|validation failed|unsupported/i.test(stderr), `exec --watch reports a later generation failure: ${stderr}`);
    assert.equal(parent.exitCode, null, 'a later watch generation failure must not kill the exec child');
    const heartbeatBefore = fs.readFileSync(heartbeat, 'utf8');
    await until(() => !['', heartbeatBefore].includes(fs.readFileSync(heartbeat, 'utf8')), 'the child must remain alive after a watch failure');

    fs.writeFileSync(api, initialDocument.replace('getMoney', 'listItems'));
    await until(
      () => fs.existsSync(path.join(root, 'sdk/client.ts'))
        && fs.readFileSync(path.join(root, 'sdk/client.ts'), 'utf8').includes('listItems'),
      `exec --watch recovers after a failed generation (stdout=${stdout}, stderr=${stderr})`,
    );

    assert.equal(parent.kill('SIGTERM'), true, 'watch parent should still be running after recovery');
    const result = await waitForCloseWithin(parent, 'exec --watch signal cleanup');
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(result.code, null);
    assert.equal(fs.readFileSync(received, 'utf8'), 'SIGTERM');
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) await stopChild(parent);
  }
});

test('exec --watch does not start its child or watcher when initial generation fails', async (t: TestContext) => {
  const { root, config } = combinedFixture(t);
  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const ready = path.join(root, 'never-started.ready');
  const childScript = copyFixtureFile(root, 'pipeline/never-started-child/run.cjs', 'never-started-child.cjs');
  fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify({ openapi: '2.0', info: {}, paths: {} }));
  const parent = spawn(process.execPath, [
    binary,
    'exec',
    '--watch',
    '--config',
    config,
    '--',
    process.execPath,
    childScript,
    ready,
  ], {
    cwd: root,
    env: { ...process.env, NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  parent.stderr?.on('data', (value: Buffer) => { stderr += value.toString(); });
  try {
    const result = await waitForCloseWithin(parent, 'initial exec --watch failure');
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(ready), false, 'the exec child must not start before initial generation succeeds');
    assert.match(stderr, /OpenAPI|validation failed|unsupported/i);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) await stopChild(parent);
  }
});

test('exec --watch exits with its child and releases the watcher', async (t: TestContext) => {
  const { root, config } = combinedFixture(t);
  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const ready = path.join(root, 'watch-child-exit.ready');
  const childScript = copyFixtureFile(root, 'pipeline/exiting-child/run.cjs', 'exiting-child.cjs');
  const parent = spawn(process.execPath, [
    binary,
    'exec',
    '--watch',
    '--config',
    config,
    '--',
    process.execPath,
    childScript,
    ready,
  ], {
    cwd: root,
    env: { ...process.env, NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await until(() => fs.existsSync(ready), 'exec --watch child starts before exiting');
    const result = await waitForCloseWithin(parent, 'exec --watch child exit cleanup');
    assert.equal(result.signal, null);
    assert.equal(result.code, 17);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) await stopChild(parent);
  }
});

test('public OpenAPI generation rejects names colliding across exported index modules', async (t: TestContext) => {
  for (const schemaName of ['PaymentsClient', 'SchemaName', 'ResponseLink', 'ValidationResult']) {
    const root = createFixtureProject(t, 'golem-openapi-name-collision-');

    const input = path.join(root, 'api.json');
    fs.writeFileSync(input, JSON.stringify(collisionDocument([schemaName], schemaName === 'ResponseLink')));
    await assert.rejects(
      () => generateOpenApi({
        input,
        output: path.join(root, 'sdk'),
        name: 'Payments',
        profile: { mobx: false, validation: true, ajvStandalone: false, allowAny: false },
      }),
      new RegExp(`collision.*${schemaName}|${schemaName}.*collision`, 'i'),
      `${schemaName} must be rejected before emitting an invalid public index`,
    );
  }
});

test('public OpenAPI generation permits validation-off ValidationResult and repeated fields', async (t: TestContext) => {
  const validationOff = await generatedOpenApiFixture(t, ['ValidationResult'], false);
  compileGeneratedSdk(validationOff, [], { noEmit: true, skipLibCheck: true });

  const repeatedFields = await generatedOpenApiFixture(t, ['First', 'Second'], false);
  compileGeneratedSdk(repeatedFields, [], { noEmit: true, skipLibCheck: true });

  const noLinks = await generatedOpenApiFixture(t, ['ResponseLink'], true);
  assert.equal(fs.existsSync(path.join(noLinks, 'links.ts')), false);
  compileGeneratedSdk(noLinks, [], { noEmit: true, strict: true, noUnusedLocals: true, noUnusedParameters: true, skipLibCheck: true });
});

test('pipeline rejects malformed or profile-mismatched returned manifests before any output write', async t => {
  const cases = [
    {
      name: 'malformed',
      manifest: {
        profile: { mobx: false, validation: true, ajvStandalone: false, allowAny: false },
        models: [{ id: 'bad-entry' }],
      },
      error: /Invalid model entry/,
    },
    {
      name: 'profile-missing-standalone',
      manifest: {
        profile: { mobx: false, validation: true, allowAny: false },
        models: [],
      },
      error: /profile must include mobx, validation, ajvStandalone and allowAny booleans/,
    },
    {
      name: 'profile-mismatch',
      manifest: {
        profile: { mobx: false, validation: true, ajvStandalone: false, allowAny: true },
        models: [],
      },
      error: /different generation profile/,
    },
  ] as const;

  for (const entry of cases) {
    const root = createFixtureProject(t, `golem-pipeline-manifest-${entry.name}-`);

    linkPackages(root, ['golem', 'golem-model', 'golem-openapi']);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'manifest-fixture', private: true, type: 'module' }));
    writeFixture(root, { mobx: false, validation: true }, false);
    installFakeOpenApiProvider(root, entry.manifest);

    const output = path.join(root, 'sdk');
    fs.mkdirSync(output, { recursive: true });
    const sentinel = path.join(output, 'existing.ts');
    fs.writeFileSync(sentinel, `sentinel:${entry.name}\n`);
    const before = fs.readFileSync(sentinel, 'utf8');
    await assert.rejects(() => runPipeline(path.join(root, 'golem.yaml')), entry.error);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), before, `${entry.name} keeps existing output intact`);
    assert.equal(fs.existsSync(path.join(output, 'model-manifest.json')), false, `${entry.name} writes no returned manifest`);
  }
});
