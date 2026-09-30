import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runPipeline } from '#codegen/cli';
import { command, workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';
import { readGeneratedModelSource } from './openapi/helpers.js';

function fixture(t: TestContext): { root: string; config: string } {
  const root = createFixtureProject(t, 'runic-pipeline-');

  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map(name => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"pipeline-fixture","type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  return { root, config: path.join(root, 'golem.yaml') };
}

async function until(check: () => boolean, message: string, timeout = 20000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}

test('frontend models generated from an out-of-src SDK manifest do not re-emit its validation pattern', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const state = await runPipeline(config);
  const generated = fs.readFileSync(path.join(root, 'src/cart.model.generated.ts'), 'utf8');
  assert.match(generated, /MoneyModel/);
  assert.doesNotMatch(generated, /\^\[A-Z\]/);
  assert.equal(state.inputs.has(path.join(root, 'sdk/model-manifest.json')), false);
});

test('global profile changes remove obsolete validation and keep manifest identity', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  const manifestFile = path.join(root, 'sdk/model-manifest.json');
  const before = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    models: { id: string }[];
    profile: { mobx: boolean; validation: boolean };
  };
  assert.match(fs.readFileSync(path.join(root, 'sdk/schemas.ts'), 'utf8'), /createRuntimeValidators/);
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('validation: true', 'validation: false'));
  await assert.rejects(runPipeline(config, { check: true }), /stale/);
  await runPipeline(config);
  const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    models: { id: string }[];
    profile: { mobx: boolean; validation: boolean };
  };
  assert.deepEqual(after.models.map((model) => model.id), before.models.map((model) => model.id));
  assert.deepEqual(after.profile, { mobx: false, validation: false, ajvStandalone: false, allowAny: false });
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'sdk/schemas.ts'), 'utf8'), /createRuntimeValidators/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/cart.model.generated.ts'), 'utf8'), /\$validator|modelTypeDefinitions/);
  await runPipeline(config, { check: true });
});

test('a generator package newer than the installed runtime is rejected before any file is written', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const provider = path.join(root, 'node_modules/@exprtlabs/golem-openapi');
  fs.rmSync(provider, { recursive: true });
  fs.mkdirSync(path.join(provider, 'dist'), { recursive: true });
  const source = path.join(workspace, 'packages/golem-openapi');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')) as { version: string };
  fs.writeFileSync(path.join(provider, 'package.json'), JSON.stringify({ ...manifest, version: '1.99.0' }));
  fs.copyFileSync(path.join(source, 'dist/generator.js'), path.join(provider, 'dist/generator.js'));
  await assert.rejects(runPipeline(config), /@exprtlabs\/golem \S+ is older than @exprtlabs\/golem-openapi 1\.99\.0/);
  assert.equal(fs.existsSync(path.join(root, 'sdk')), false);
  assert.equal(fs.existsSync(path.join(root, '.golem')), false);
});

test('exec forwards child failure and never starts a child after generator failure', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const result = await command(root, process.execPath, [binary, 'exec', '--config', config, '--', process.execPath, '-e', 'process.exit(7)'], { allowFailure: true });
  assert.equal(result.code, 7);
  fs.writeFileSync(path.join(root, 'api.json'), '{}');
  const marker = path.join(root, 'child-ran');
  const markerScript = copyFixtureFile(root, 'pipeline/failure-marker/run.cjs', 'failure-marker.cjs');
  const failed = await command(root, process.execPath, [binary, 'exec', '--', process.execPath, markerScript, marker], { allowFailure: true });
  assert.notEqual(failed.code, 0);
  assert.equal(fs.existsSync(marker), false);
});

test('watch regenerates model edits without rewriting SDKs or looping on outputs', async (t: TestContext) => {
  const { root } = fixture(t);
  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const child = spawn(process.execPath, [binary, 'watch'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (value: Buffer) => { stdout += value.toString(); });
  child.stderr.on('data', (value: Buffer) => { stderr += value.toString(); });
  try {
    await until(() => stdout.includes('Generated configured outputs.'), `initial watch generation: ${stderr}`);
    const sdk = path.join(root, 'sdk/index.ts');
    const sdkMtime = fs.statSync(sdk).mtimeMs;
    const modelSource = path.join(root, 'src/cart.model.ts');
    fs.writeFileSync(modelSource, fs.readFileSync(modelSource, 'utf8').replace('note: string', 'note: string; selected?: boolean'));
    const generated = path.join(root, 'src/cart.model.generated.ts');
    const runs = () => (stdout.match(/Generated configured outputs\./g) || []).length;
    await until(() => runs() >= 2 && fs.readFileSync(generated, 'utf8').includes('selected'), `model regeneration: ${stderr}`);
    assert.equal(fs.statSync(sdk).mtimeMs, sdkMtime);
    // The next source edit is the observation point: a run triggered by outputs would precede its single run.
    fs.writeFileSync(modelSource, fs.readFileSync(modelSource, 'utf8').replace('note: string', 'note: string; probe?: string'));
    await until(() => runs() >= 3 && fs.readFileSync(generated, 'utf8').includes('probe'), `probe regeneration: ${stderr}`);
    assert.equal(runs(), 3, stdout + stderr);
    assert.equal(fs.statSync(sdk).mtimeMs, sdkMtime);
    assert.equal(stderr, '');
    const api = path.join(root, 'api.json');
    const validApi = fs.readFileSync(api, 'utf8');
    fs.writeFileSync(api, '{}');
    await until(() => stderr.length > 0, 'failed OpenAPI change is reported');
    const previousErrorLength = stderr.length;
    fs.writeFileSync(modelSource, fs.readFileSync(modelSource, 'utf8').replace('selected?: boolean', 'selected?: boolean; attempt?: number'));
    await until(() => stderr.length > previousErrorLength, 'model edit retries failed upstream generation');
    assert.doesNotMatch(fs.readFileSync(generated, 'utf8'), /attempt/);
    fs.writeFileSync(api, validApi);
    await until(() => fs.readFileSync(generated, 'utf8').includes('attempt') && runs() >= 4, 'watch recovers after upstream input is repaired');
    assert.equal(runs(), 4, 'failed upstream runs publish nothing and recovery runs once');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
    }
  }
});

// ---------------------------------------------------------------------------
// Deleting a discovered model cleans its companion; deleting the final one also cleans a modified companion
// ---------------------------------------------------------------------------

test('deleting a discovered model cleans its generated companion, and deleting the final one cleans the inventory', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const extra = path.join(root, 'src/extra.model.ts');
  fs.writeFileSync(extra, "import type {IModel} from '@exprtlabs/golem/model'; export type TExtra=IModel<{value:string}>;\n");
  await runPipeline(config);
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const extraCompanion = path.join(root, 'src/extra.model.generated.ts');
  assert.equal(fs.existsSync(companion), true);
  assert.equal(fs.existsSync(extraCompanion), true);

  // Removing one source cleans its companion and preserves the other's.
  fs.unlinkSync(extra);
  await assert.rejects(runPipeline(config, { check: true }), /stale/);
  await runPipeline(config);
  assert.equal(fs.existsSync(extraCompanion), false);
  assert.equal(fs.existsSync(companion), true);

  // A local edit to the companion must not block its removal once the
  // discovered model that owns it is gone.
  fs.appendFileSync(companion, '\n// user manual change\n');

  // Delete the only model in the project
  const source = path.join(root, 'src/cart.model.ts');
  fs.unlinkSync(source);

  // Check reports stale outputs
  await assert.rejects(runPipeline(config, { check: true }), /stale/);

  // Rerunning pipeline reconciles the now-empty model job, removing the obsolete companion
  await runPipeline(config);
  assert.equal(fs.existsSync(companion), false);

  const inventory = JSON.parse(fs.readFileSync(path.join(root, '.golem/outputs.json'), 'utf8')) as {
    files: Record<string, unknown>;
  };
  assert.equal(Object.keys(inventory.files).some((f) => f.includes('cart.model.generated')), false);
  assert.equal(Object.keys(inventory.files).some((f) => f.startsWith('sdk/')), true);
});

test('an unreferenced OpenAPI document does not regenerate model companions', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const other = path.join(root, 'other.json');
  fs.writeFileSync(other, JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Other', version: '1' },
    paths: {},
    components: {
      schemas: {
        Note: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
      },
    },
  }));
  fs.writeFileSync(config, [
    'version: 1',
    'mobx: false',
    'validation: true',
    'ajvStandalone: false',
    'openapi:',
    '  - input: api.json',
    '    output: sdk',
    '    name: Profile',
    '  - input: other.json',
    '    output: other-sdk',
    '    name: Other',
    'models:',
    '  root: .',
    '',
  ].join('\n'));
  const first = await runPipeline(config);
  const companion = path.join(root, 'src/cart.model.generated.ts');
  fs.appendFileSync(companion, '\n// companion marker\n');
  const otherSdk = path.join(root, 'other-sdk');
  const beforeOther = readGeneratedModelSource(otherSdk);
  const spec = JSON.parse(fs.readFileSync(other, 'utf8')) as {
    components: { schemas: { Note: { properties: Record<string, unknown> } } };
  };
  spec.components.schemas.Note.properties.extra = { type: 'string' };
  fs.writeFileSync(other, JSON.stringify(spec));
  const second = await runPipeline(config, { previous: first, changedInputs: [other] });
  assert.match(fs.readFileSync(companion, 'utf8'), /companion marker/);
  assert.notEqual(readGeneratedModelSource(otherSdk), beforeOther);
  const api = path.join(root, 'api.json');
  const apiSpec = JSON.parse(fs.readFileSync(api, 'utf8')) as { info: { title: string } };
  apiSpec.info.title = 'Profile changed';
  fs.writeFileSync(api, JSON.stringify(apiSpec));
  await runPipeline(config, { previous: second, changedInputs: [api] });
  assert.doesNotMatch(fs.readFileSync(companion, 'utf8'), /companion marker/);
});
