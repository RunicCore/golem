// lane: typescript6 ProgramSession resolution updates in the pipeline runtime
import { copyFixtureFile, createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { test, type TestContext } from 'node:test';

import { runPipeline, watchPipeline } from '#golem/cli';
import { generate as generateOpenApi } from '#openapi/generator';
import { spawnWatchExec, stopChild, workspace } from './support/process.js';
import { generationWatchFixture } from './support/generation-watch.js';
import { writeMoneyManifest } from './support/model-manifest.js';
import { until } from './support/watch-wait.js';
import { runLines } from './support/watch-runs.js';
import { writeFixture } from './support/consumer.js';

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

function modelWatchFixture(t: TestContext): ModelWatchFixture {
  const { root } = createModelProject(t, {
    prefix: 'golem-model-watch-',
    name: 'model-watch-fixture',
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
  });
  fs.mkdirSync(path.join(root, 'src/external'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'golem.yaml'),
    'version: 1\nmobx: false\nvalidation: false\nallowAny: false\nmodels:\n  root: .\n',
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
  writeMoneyManifest(fixture.manifest);
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
    profile: { mobx: false, validation, allowAny: false },
  });
  writeGeneratedArtifacts(result.artifacts);
  fs.writeFileSync(path.join(output, 'package.json'), '{"type":"module"}');
  linkProjectPackages(output, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  return output;
}

/** The generated SDKs under `sdks` (case name to folder), type-checked in one compiler run; a failure names each case whose files the compiler reports. */
function compileGeneratedSdks(sdks: Readonly<Record<string, string>>, flags: readonly string[]): void {
  const javascript = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : javascript(filename);
    return entry.name.endsWith('.generated.js') ? [filename] : [];
  });
  const files = Object.values(sdks).flatMap((sdk) => [path.join(sdk, 'index.ts'), ...javascript(sdk)]);
  const compiled = spawnSync(process.execPath, [
    path.join(workspace, 'tests/tsc-cli.mjs'), '--noEmit', '--allowJs', '--lib', 'ES2023,ESNext.Collection,DOM,DOM.Iterable', ...flags, ...files,
  ], { encoding: 'utf8' });
  const output = `${compiled.stdout}${compiled.stderr}`;
  const failed = Object.entries(sdks).filter(([, sdk]) => output.includes(path.basename(path.dirname(sdk)))).map(([name]) => name);
  assert.equal(compiled.status, 0, `the generated SDK compiles; the compiler reports ${failed.join(', ') || 'no case by name'}:\n${output}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

test('initial watch failure records a missing configured input and recovers on creation, and a config edit to another missing input recovers the same way', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
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

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`exec forwards ${signal} to its child and preserves the signal result`, async (t: TestContext) => {
    const { root, config } = generationWatchFixture(t);
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
      await stopChild(parent);
    }
  });
}

test('exec --watch keeps its child alive through generation failure, recovers, and cleans up on signal', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const ready = path.join(root, 'watch-child.ready');
  const received = path.join(root, 'watch-child.received');
  const heartbeat = path.join(root, 'watch-child.heartbeat');
  const childScript = copyFixtureFile(root, 'pipeline/watch-child/run.cjs', 'watch-child.cjs');
  const parent = spawnWatchExec(root, config, [childScript, ready, received, heartbeat]);
  let stdout = '';
  let stderr = '';
  parent.stdout?.on('data', (value: Buffer) => { stdout += value.toString(); });
  parent.stderr?.on('data', (value: Buffer) => { stderr += value.toString(); });
  const api = path.join(root, 'api.json');
  const initialDocument = fs.readFileSync(api, 'utf8');

  try {
    await until(() => runLines(stdout).length > 0 && fs.existsSync(ready), `exec --watch initial generation: ${stderr}`);

    fs.writeFileSync(api, JSON.stringify({ openapi: '2.0', info: {}, paths: {} }));
    await until(() => /OpenAPI|validation failed|unsupported/i.test(stderr), `exec --watch reports a later generation failure: ${stderr}`);
    assert.equal(parent.exitCode, null, 'a later watch generation failure must not kill the exec child');
    // The failure is reported within the debounce of the edit, which can come before the child's first heartbeat.
    await until(() => fs.existsSync(heartbeat) && fs.readFileSync(heartbeat, 'utf8') !== '', 'the child writes its first heartbeat');
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
    await stopChild(parent);
  }
});

test('exec --watch does not start its child or watcher when initial generation fails', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const ready = path.join(root, 'never-started.ready');
  const childScript = copyFixtureFile(root, 'pipeline/never-started-child/run.cjs', 'never-started-child.cjs');
  fs.writeFileSync(path.join(root, 'api.json'), JSON.stringify({ openapi: '2.0', info: {}, paths: {} }));
  const parent = spawnWatchExec(root, config, [childScript, ready]);
  let stderr = '';
  parent.stderr?.on('data', (value: Buffer) => { stderr += value.toString(); });
  try {
    const result = await waitForCloseWithin(parent, 'initial exec --watch failure');
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(ready), false, 'the exec child must not start before initial generation succeeds');
    assert.match(stderr, /OpenAPI|validation failed|unsupported/i);
  } finally {
    await stopChild(parent);
  }
});

test('exec --watch generates a model file that was created during its first run', async (t: TestContext) => {
  // protects: T-316 the watch started by exec compares with the disk as it was before the first run
  const { root, config } = generationWatchFixture(t);
  const created = path.join(root, 'src/pet.model.ts');
  // In the exec process: the first run publishes the cart companion, after it read the sources; create a model file at that moment.
  const hook = path.join(root, 'create-during-first-run.cjs');
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    'let created = false;',
    'const rename = fs.renameSync;',
    'fs.renameSync = (from, to) => {',
    "  if (!created && String(to).endsWith('cart.model.generated.ts')) {",
    '    created = true;',
    `    fs.writeFileSync(${JSON.stringify(created)}, "import type { IModel } from '@exprtlabs/golem/model';\\n\\nexport type TPet = IModel<{ id: string }>;\\n");`,
    '  }',
    '  return rename(from, to);',
    '};',
  ].join('\n'));
  const parent = spawnWatchExec(root, config, ['-e', 'setInterval(() => {}, 1000)'], ['--require', hook]);
  let stderr = '';
  parent.stderr?.on('data', (value: Buffer) => { stderr += value.toString(); });
  try {
    await until(() => fs.existsSync(path.join(root, 'src/pet.model.generated.ts')), () => `the model created during the first run is generated (stderr=${stderr})`);
    assert.ok(fs.existsSync(created));
  } finally {
    await stopChild(parent);
  }
});

test('exec --watch exits with its child and releases the watcher', async (t: TestContext) => {
  const { root, config } = generationWatchFixture(t);
  const ready = path.join(root, 'watch-child-exit.ready');
  const childScript = copyFixtureFile(root, 'pipeline/exiting-child/run.cjs', 'exiting-child.cjs');
  const parent = spawnWatchExec(root, config, [childScript, ready]);
  try {
    await until(() => fs.existsSync(ready), 'exec --watch child starts before exiting');
    const result = await waitForCloseWithin(parent, 'exec --watch child exit cleanup');
    assert.equal(result.signal, null);
    assert.equal(result.code, 17);
  } finally {
    await stopChild(parent);
  }
});

test('public OpenAPI generation rejects names colliding across exported index modules', async (t: TestContext) => {
  for (const schemaName of ['PaymentsClient', 'ResponseLink']) {
    const root = createFixtureProject(t, 'golem-openapi-name-collision-');

    const input = path.join(root, 'api.json');
    fs.writeFileSync(input, JSON.stringify(collisionDocument([schemaName], schemaName === 'ResponseLink')));
    await assert.rejects(
      () => generateOpenApi({
        input,
        output: path.join(root, 'sdk'),
        name: 'Payments',
        profile: { mobx: false, validation: true, allowAny: false },
      }),
      new RegExp(`collision.*${schemaName}|${schemaName}.*collision`, 'i'),
      `${schemaName} must be rejected before emitting an invalid public index`,
    );
  }
});

test('public OpenAPI generation permits SchemaName, ValidationResult and repeated fields', async (t: TestContext) => {
  const sdks: Record<string, string> = {};
  for (const name of ['SchemaName', 'ValidationResult']) {
    for (const validation of [false, true]) {
      sdks[`${name} with validation ${validation}`] = await generatedOpenApiFixture(t, [name], validation);
    }
  }
  sdks['repeated fields'] = await generatedOpenApiFixture(t, ['First', 'Second'], false);
  compileGeneratedSdks(sdks, ['--skipLibCheck']);

  const noLinks = await generatedOpenApiFixture(t, ['ResponseLink'], true);
  assert.equal(fs.existsSync(path.join(noLinks, 'links.ts')), false);
  compileGeneratedSdks({ 'no links': noLinks }, ['--strict', '--noUnusedLocals', '--noUnusedParameters', '--skipLibCheck']);
});

test('pipeline rejects malformed or profile-mismatched returned manifests before any output write', async t => {
  const cases = [
    {
      name: 'malformed',
      manifest: {
        profile: { mobx: false, validation: true, allowAny: false },
        models: [{ id: 'bad-entry' }],
      },
      error: /Invalid model entry/,
    },
    {
      name: 'profile-missing-allow-any',
      manifest: {
        profile: { mobx: false, validation: true },
        models: [],
      },
      error: /profile must include mobx, validation and allowAny booleans/,
    },
    {
      name: 'profile-mismatch',
      manifest: {
        profile: { mobx: false, validation: true, allowAny: true },
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
