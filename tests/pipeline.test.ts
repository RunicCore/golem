import { copyFixtureFile, createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runPipeline, type PipelineState } from '#golem/cli';
import { runBuild } from '#golem/build';
import { command, workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';
import { readGeneratedModelSource } from './openapi/helpers.js';

function fixture(t: TestContext): { root: string; config: string } {
  const root = createFixtureProject(t, 'golem-pipeline-');

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
  assert.match(readGeneratedModelSource(path.join(root, 'sdk')), /@exprtlabs\/golem\/ajv/);
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('validation: true', 'validation: false'));
  await assert.rejects(runPipeline(config, { check: true }), /stale/);
  await runPipeline(config);
  const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    models: { id: string }[];
    profile: { mobx: boolean; validation: boolean };
  };
  assert.deepEqual(after.models.map((model) => model.id), before.models.map((model) => model.id));
  assert.deepEqual(after.profile, { mobx: false, validation: false, ajvStandalone: false, allowAny: false });
  assert.doesNotMatch(readGeneratedModelSource(path.join(root, 'sdk')), /@exprtlabs\/golem\/ajv/);
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

test('deleting a model while editing the model its companion imports still generates and removes the orphan companion', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const owner = path.join(root, 'src/owner.model.ts');
  const shared = path.join(root, 'src/shared.model.ts');
  fs.writeFileSync(owner, "import type { IModel } from '@exprtlabs/golem/model';\nimport type { TShared } from './shared.model.js';\nexport type TOwner = IModel<{ shared: TShared }>;\n");
  const sharedSource = (fields: string): string => `import type { IObject } from '@exprtlabs/golem/model';\nexport type TShared = IObject<{ ${fields} }>;\n`;
  fs.writeFileSync(shared, sharedSource('value: string'));
  await runPipeline(config);
  const ownerCompanion = path.join(root, 'src/owner.model.generated.ts');
  assert.equal(fs.existsSync(ownerCompanion), true);

  // The orphan companion imports the shared model's codec helpers, whose names carry the shared model's shape hash. After the
  // edit the orphan fails to compile against the new companion unless the run treats it as its own output to remove.
  fs.unlinkSync(owner);
  fs.writeFileSync(shared, sharedSource('value: string; extra: number'));
  await runPipeline(config);
  assert.equal(fs.existsSync(ownerCompanion), false);
  assert.match(fs.readFileSync(path.join(root, 'src/shared.model.generated.ts'), 'utf8'), /extra/);
});

test('an openapi-only golem.yaml with no tsconfig has no project to check, and golem build names the missing tsconfig', async (t: TestContext) => {
  const { root, config } = fixture(t);
  fs.rmSync(path.join(root, 'tsconfig.json'));
  fs.writeFileSync(config, 'version: 1\nmobx: false\nvalidation: true\nopenapi:\n  - input: api.json\n    output: sdk\n    name: Profile\n');
  await runPipeline(config);
  assert.equal(fs.existsSync(path.join(root, 'sdk')), true);
  await runPipeline(config, { check: true });
  await assert.rejects(runBuild({ watch: false, config }), /golem build cannot find .*tsconfig\.json, the tsconfig .*golem\.yaml names/);
});

// ---------------------------------------------------------------------------
// The job cache: a run skips the jobs whose inputs did not change
// ---------------------------------------------------------------------------

/** The kinds of the jobs that executed in a run, in a stable order. */
function ranKinds(state: PipelineState): string[] {
  return state.config.jobs.filter((job) => state.ran.has(job.id)).map((job) => job.kind);
}

test('a second generate with no input change runs no job and rewrites no output', async (t: TestContext) => {
  const { config } = fixture(t);
  const first = await runPipeline(config);
  assert.deepEqual(ranKinds(first), ['openapi', 'models']);
  const modifiedAt = new Map([...first.owned].map((output) => [output, fs.statSync(output).mtimeMs]));
  const second = await runPipeline(config);
  assert.deepEqual([...second.ran], []);
  assert.deepEqual([...second.owned].sort(), [...first.owned].sort(), 'a skipped job still owns its outputs');
  for (const [output, mtime] of modifiedAt) assert.equal(fs.statSync(output).mtimeMs, mtime, output);
});

test('an edited model source reruns the models job, an edited OpenAPI document reruns the models job that reads its manifest', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  const modelSource = path.join(root, 'src/cart.model.ts');
  fs.writeFileSync(modelSource, fs.readFileSync(modelSource, 'utf8').replace('note: string', 'note: string; selected?: boolean'));
  const edited = await runPipeline(config);
  assert.deepEqual(ranKinds(edited), ['models'], 'the OpenAPI job reads no model source');
  assert.match(fs.readFileSync(path.join(root, 'src/cart.model.generated.ts'), 'utf8'), /selected/);
  assert.deepEqual(ranKinds(await runPipeline(config)), []);

  const api = path.join(root, 'api.json');
  fs.writeFileSync(api, JSON.stringify(JSON.parse(fs.readFileSync(api, 'utf8')), null, 4));
  assert.deepEqual(ranKinds(await runPipeline(config)), ['openapi', 'models'], 'the manifest the OpenAPI job writes is the same, the job after it still runs');
});

test('a deleted output reruns its job, and a changed option or golem version reruns the jobs it applies to', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const original = fs.readFileSync(companion, 'utf8');
  fs.rmSync(companion);
  assert.deepEqual(ranKinds(await runPipeline(config)), ['models']);
  assert.equal(fs.readFileSync(companion, 'utf8'), original);

  const records = path.join(root, '.golem/jobs.json');
  const written = JSON.parse(fs.readFileSync(records, 'utf8')) as { jobs: Record<string, { golem: string }> };
  const modelsId = Object.keys(written.jobs).find((id) => id.startsWith('models:'));
  assert.ok(modelsId, 'the models job has a record');
  written.jobs[modelsId].golem = '0.0.0-other';
  fs.writeFileSync(records, JSON.stringify(written));
  assert.deepEqual(ranKinds(await runPipeline(config)), ['models']);

  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('validation: true', 'validation: false'));
  assert.deepEqual(ranKinds(await runPipeline(config)), ['openapi', 'models']);
  assert.deepEqual(ranKinds(await runPipeline(config)), []);
});

test('a job that edits an input after it read it runs again, because its record holds the digest from the read', async (t: TestContext) => {
  const root = createFixtureProject(t, 'golem-pipeline-read-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"read-fixture","type":"module"}');
  const provider = path.join(root, 'node_modules/@fixture/rewriter');
  fs.mkdirSync(provider, { recursive: true });
  fs.writeFileSync(path.join(provider, 'package.json'), JSON.stringify({ name: '@fixture/rewriter', version: '1.0.0', type: 'module', exports: { './generator': './index.js' } }));
  fs.writeFileSync(path.join(provider, 'index.js'), `import fs from 'node:fs';
import path from 'node:path';
export const apiVersion = 1;
export function generate(context) {
  const input = path.join(context.directory, 'input.txt');
  context.onInput(input);
  const text = fs.readFileSync(input, 'utf8');
  fs.writeFileSync(input, text + 'x');
  return { apiVersion: 1, artifacts: [{ path: path.join(context.output, 'out.txt'), content: '# Generated by @fixture/rewriter. Do not edit.\\n' + text.length }], manifestPaths: [], watchInputs: [input] };
}
`);
  fs.writeFileSync(path.join(root, 'input.txt'), 'x');
  fs.writeFileSync(path.join(root, 'golem.yaml'), ['version: 1', 'generators:', "  - package: '@fixture/rewriter'", '    output: out', ''].join('\n'));
  const config = path.join(root, 'golem.yaml');
  assert.deepEqual([...(await runPipeline(config)).ran].length, 1);
  assert.deepEqual([...(await runPipeline(config)).ran].length, 1, 'the file changed after the job read it, so the second run is not a cache hit');
});

test('a watch run after a cached start reruns the job that reads an output of an edited, skipped job', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  fs.rmSync(path.join(root, 'src/cart.model.generated.ts'));
  const cachedStart = await runPipeline(config);
  assert.deepEqual(ranKinds(cachedStart), ['models'], 'the OpenAPI job is skipped and has no result');
  assert.equal(cachedStart.results.size, 1);
  const api = path.join(root, 'api.json');
  fs.writeFileSync(api, JSON.stringify(JSON.parse(fs.readFileSync(api, 'utf8')), null, 4));
  const next = await runPipeline(config, { previous: cachedStart, changedInputs: [api] });
  assert.deepEqual(ranKinds(next), ['openapi', 'models'], 'the models job reads the manifest of the OpenAPI job');
});

test('check reports an unresolved parse call with its code and writes no file', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  fs.writeFileSync(path.join(root, 'src/use.ts'), "import { parse } from '@exprtlabs/golem/serde';\nexport const bad = parse<string | null>('{}');\n");
  const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
  const records = fs.readFileSync(path.join(root, '.golem/jobs.json'), 'utf8');
  await assert.rejects(runPipeline(config, { check: true }), /RUNM1066 \(src\/use\.ts:2:20\): parse type argument must be a single type name or typeof expression/);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).map(String).sort(), before);
  assert.equal(fs.readFileSync(path.join(root, '.golem/jobs.json'), 'utf8'), records);
});

test('removing the OpenAPI job reruns the models job that read its output instead of skipping it', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  fs.writeFileSync(config, ['version: 1', 'mobx: false', 'validation: true', 'models:', '  root: .', ''].join('\n'));
  await assert.rejects(runPipeline(config), /Cannot find module|cannot find module|TS2307|sdk[\\/]index/);
  assert.equal(fs.existsSync(path.join(root, 'sdk/index.ts')), false);
});

/** A project with one third-party generator job that announces `input.txt` when it reads it, or reports it without announcing it. */
function generatorProject(t: TestContext, announce: boolean): { root: string; config: string; install: (version: string) => void } {
  const root = createFixtureProject(t, 'golem-pipeline-generator-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"generator-fixture","type":"module"}');
  const provider = path.join(root, 'node_modules/@fixture/reader');
  const install = (version: string): void => {
    fs.mkdirSync(provider, { recursive: true });
    fs.writeFileSync(path.join(provider, 'package.json'), JSON.stringify({ name: '@fixture/reader', version, type: 'module', exports: { './generator': './index.js' } }));
    fs.writeFileSync(path.join(provider, 'index.js'), `import fs from 'node:fs';
import path from 'node:path';
export const apiVersion = 1;
export function generate(context) {
  const input = path.join(context.directory, 'input.txt');
  ${announce ? 'context.onInput(input);' : ''}
  const text = fs.readFileSync(input, 'utf8');
  return { apiVersion: 1, artifacts: [{ path: path.join(context.output, 'out.txt'), content: '# Generated by @fixture/reader. Do not edit.\\n' + text }], manifestPaths: [], watchInputs: [input] };
}
`);
  };
  install('1.0.0');
  fs.writeFileSync(path.join(root, 'input.txt'), 'x');
  fs.writeFileSync(path.join(root, 'golem.yaml'), ['version: 1', 'generators:', "  - package: '@fixture/reader'", '    output: out', ''].join('\n'));
  return { root, config: path.join(root, 'golem.yaml'), install };
}

test('a new version of a generator package reruns its job although its options and inputs are the same', async (t: TestContext) => {
  const { config, install } = generatorProject(t, true);
  assert.equal((await runPipeline(config)).ran.size, 1);
  assert.equal((await runPipeline(config)).ran.size, 0);
  install('1.1.0');
  assert.equal((await runPipeline(config)).ran.size, 1);
  assert.equal((await runPipeline(config)).ran.size, 0);
});

test('a watch input the job did not announce has no digest from the read, so its job always runs', async (t: TestContext) => {
  const { config } = generatorProject(t, false);
  assert.equal((await runPipeline(config)).ran.size, 1);
  assert.equal((await runPipeline(config)).ran.size, 1);
});
