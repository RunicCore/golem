// lane: typescript6 ProgramSession resolution updates and the `golem build` driver in the pipeline
import { copyFixtureFile, createFixtureProject, linkProjectPackages, linkGolemPackages, listProjectDependencies } from './fixture-project.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runPipeline, type PipelineState } from '#golem/cli';
import { loadConfig } from './support/load-config.js';
import { applyJob, loadInventory } from '#golem/outputs';
import { runBuild } from '#golem/build';
import { command, stopChild, workspace } from './support/process.js';
import { TSC, write as writeFile } from './support/build-project.js';
import { workspaceLinkedProject, writeFixture } from './support/consumer.js';
import { until } from './support/watch-wait.js';
import { runLines } from './support/watch-runs.js';

function fixture(t: TestContext): { root: string; config: string } {
  const root = workspaceLinkedProject(t, 'golem-pipeline-', '{"name":"pipeline-fixture","type":"module"}');
  writeFixture(root, { mobx: false, validation: true });
  return { root, config: path.join(root, 'golem.yaml') };
}

test('frontend models generated from an out-of-src SDK manifest read an SDK type as a plain type', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const state = await runPipeline(config);
  const generated = fs.readFileSync(path.join(root, 'src/cart.model.generated.ts'), 'utf8');
  // The SDK writes no model class, so the companion holds the fields of Money itself.
  assert.match(generated, /money: \{ amount: number; currency: string \}/);
  assert.equal(state.inputs.has(path.join(root, 'sdk/model-manifest.json')), false);
});

test('a golem.yaml with an openapi job and the exact key generates the SDK and the models that use it', async (t: TestContext) => {
  const { config } = fixture(t);
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('validation: true', 'validation: true\nexact: false'));
  await runPipeline(config);
  await runPipeline(config, { check: true });
});

test('global profile changes remove obsolete validation and keep manifest identity', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  const manifestFile = path.join(root, 'sdk/model-manifest.json');
  const before = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    models: { id: string }[];
    profile: { mobx: boolean; validation: boolean };
  };
  // A fresh process reads the built SDK, so no module of an earlier build stays cached.
  const validateBreakingMoney = async (): Promise<string> => {
    await command(root, process.execPath, [TSC, '-p', 'tsconfig.json']);
    // The client reads a Money that breaks its minimum and pattern: a validating SDK refuses it, and one with validation off hands it over.
    const probe = "const { ProfileClient } = await import('./build/sdk/client.js'); const client = new ProfileClient({ baseUrl: 'https://api.test', fetchImpl: async () => Response.json({ amount: -1, currency: 'usd' }) }); let out = 'accepted'; try { await client.getMoney().execute({}); } catch (error) { out = error.kind; } process.stdout.write(out);";
    return (await command(root, process.execPath, ['--input-type=module', '-e', probe])).stdout;
  };
  assert.equal(await validateBreakingMoney(), 'validation', 'validation on: the client checks the minimum and the pattern of a response');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('validation: true', 'validation: false'));
  await assert.rejects(runPipeline(config, { check: true }), /stale/);
  await runPipeline(config);
  const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    models: { id: string }[];
    profile: { mobx: boolean; validation: boolean };
  };
  assert.deepEqual(after.models.map((model) => model.id), before.models.map((model) => model.id));
  assert.deepEqual(after.profile, { mobx: false, validation: false, allowAny: false, unknownFormats: 'error' });
  assert.equal(await validateBreakingMoney(), 'accepted', 'validation off: the client has no validator left');
  await runPipeline(config, { check: true });
});

test('a built-in generator package of another version than the installed runtime is rejected before any file is written', async (t: TestContext) => {
  // protects: T-653 a built-in generator of another version than the runtime stops golem build before it writes
  const { root, config } = fixture(t);
  const provider = path.join(root, 'node_modules/@exprtlabs/golem-openapi');
  fs.rmSync(provider, { recursive: true });
  fs.mkdirSync(path.join(provider, 'dist'), { recursive: true });
  const source = path.join(workspace, 'packages/golem-openapi');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')) as { version: string };
  // A release pins golem to its own version; the registry compares that pin with the runtime.
  fs.writeFileSync(path.join(provider, 'package.json'), JSON.stringify({ ...manifest, version: '1.99.0', dependencies: { '@exprtlabs/golem': '1.99.0' } }));
  for (const entry of ['generator', 'plan']) fs.copyFileSync(path.join(source, `dist/${entry}.js`), path.join(provider, `dist/${entry}.js`));
  await assert.rejects(runPipeline(config), /@exprtlabs\/golem \S+ and @exprtlabs\/golem-openapi 1\.99\.0 must have the same version/);
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
    await until(() => runLines(stdout).length > 0, `initial watch generation: ${stderr}`);
    const sdk = path.join(root, 'sdk/index.ts');
    const sdkMtime = fs.statSync(sdk).mtimeMs;
    const modelSource = path.join(root, 'src/cart.model.ts');
    fs.writeFileSync(modelSource, fs.readFileSync(modelSource, 'utf8').replace('note: string', 'note: string; selected?: boolean'));
    const generated = path.join(root, 'src/cart.model.generated.ts');
    const runs = () => runLines(stdout).length;
    await until(() => runs() >= 2 && fs.readFileSync(generated, 'utf8').includes('selected'), `model regeneration: ${stderr}`);
    assert.equal(fs.statSync(sdk).mtimeMs, sdkMtime);
    // The next source edit is the observation point: a run triggered by outputs would precede its single run.
    fs.writeFileSync(modelSource, fs.readFileSync(modelSource, 'utf8').replace('note: string', 'note: string; probe?: string'));
    await until(() => runs() >= 3 && fs.readFileSync(generated, 'utf8').includes('probe'), `probe regeneration: ${stderr}`);
    assert.equal(runs(), 3, stdout + stderr);
    assert.equal(fs.statSync(sdk).mtimeMs, sdkMtime);
    assert.equal(stderr, '');
    const published = fs.readFileSync(generated, 'utf8');
    const api = path.join(root, 'api.json');
    const validApi = fs.readFileSync(api, 'utf8');
    fs.writeFileSync(api, '{}');
    await until(() => stderr.length > 0, 'failed OpenAPI change is reported');
    const previousErrorLength = stderr.length;
    fs.writeFileSync(modelSource, fs.readFileSync(modelSource, 'utf8').replace('selected?: boolean', 'selected?: boolean; attempt?: number'));
    await until(() => stderr.length > previousErrorLength, 'model edit retries failed upstream generation');
    assert.equal(fs.readFileSync(generated, 'utf8'), published, 'a failed upstream run publishes nothing');
    fs.writeFileSync(api, validApi);
    await until(() => fs.readFileSync(generated, 'utf8').includes('attempt') && runs() >= 4, 'watch recovers after upstream input is repaired');
    assert.equal(runs(), 4, 'failed upstream runs publish nothing and recovery runs once');
  } finally {
    await stopChild(child);
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

test('the companion of a shared alias is a recorded output of the app in models.output, and deleting the alias removes it', async (t: TestContext) => {
  // protects: a shared model's companion is a recorded output of the app, and deleting the alias removes it
  const outer = createFixtureProject(t, 'golem-pipeline-shared-');
  linkProjectPackages(outer, Object.fromEntries(['golem', 'golem-model'].map(name => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)])));
  const write = (file: string, text: string): void => writeFile(outer, file, text);
  write('shared/package.json', '{"name":"@acme/shared","type":"module"}');
  write('shared/customer.model.ts', "import type { IModel } from '@exprtlabs/golem/model';\nexport type TCustomer = IModel<{ name: string }>;\n");
  write('app/package.json', '{"name":"shared-app","type":"module","dependencies":{"@exprtlabs/golem-model":"*"}}');
  write('app/golem.yaml', 'version: 1\nvalidation: false\nmodel: {}\n');
  write('app/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true }, include: ['src/**/*.ts', '../shared/**/*.ts'] }));
  write('app/src/use.ts', 'export {};\n');
  const config = path.join(outer, 'app/golem.yaml');
  const companion = path.join(outer, 'app/src/generated/models/@acme/shared/customer.model.generated.ts');
  const recorded = (): string[] => Object.keys((JSON.parse(fs.readFileSync(path.join(outer, 'app/.golem/outputs.json'), 'utf8')) as { files: Record<string, unknown> }).files);

  await runPipeline(config);

  assert.equal(fs.existsSync(companion), true);
  assert.deepEqual(recorded().filter((file) => file.includes('customer.model.generated')), ['src/generated/models/@acme/shared/customer.model.generated.ts']);

  fs.unlinkSync(path.join(outer, 'shared/customer.model.ts'));
  await assert.rejects(runPipeline(config, { check: true }), /stale/);
  await runPipeline(config);

  assert.equal(fs.existsSync(companion), false);
  assert.deepEqual(recorded().filter((file) => file.includes('customer.model.generated')), []);
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
    'validation: true',
    'openapi-ts:',
    '  sdks:',
    '    - input: api.json',
    '      output: sdk',
    '      name: Profile',
    '    - input: other.json',
    '      output: other-sdk',
    '      name: Other',
    'model: {}',
    '',
  ].join('\n'));
  const first = await runPipeline(config);
  const companion = path.join(root, 'src/cart.model.generated.ts');
  fs.appendFileSync(companion, '\n// companion marker\n');
  const otherSdk = path.join(root, 'other-sdk');
  const otherTypes = path.join(otherSdk, 'types.ts');
  const beforeOther = fs.readFileSync(otherTypes, 'utf8');
  const spec = JSON.parse(fs.readFileSync(other, 'utf8')) as {
    components: { schemas: { Note: { properties: Record<string, unknown> } } };
  };
  spec.components.schemas.Note.properties.extra = { type: 'string' };
  fs.writeFileSync(other, JSON.stringify(spec));
  const second = await runPipeline(config, { previous: first, changedInputs: [other] });
  assert.match(fs.readFileSync(companion, 'utf8'), /companion marker/);
  assert.notEqual(fs.readFileSync(otherTypes, 'utf8'), beforeOther);
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
  fs.writeFileSync(config, 'version: 1\nvalidation: true\nopenapi-ts:\n  sdks:\n    - input: api.json\n      output: sdk\n      name: Profile\n');
  await runPipeline(config);
  assert.equal(fs.existsSync(path.join(root, 'sdk')), true);
  await runPipeline(config, { check: true });
  await assert.rejects(runBuild({ watch: false, config }), /golem build cannot find .*tsconfig\.json, the tsconfig .*golem\.yaml names/);
});

// ---------------------------------------------------------------------------
// The job cache: a run skips the jobs whose inputs did not change
// ---------------------------------------------------------------------------

/** The blocks of the jobs that executed in a run, in a stable order. */
function ranBlocks(state: PipelineState): string[] {
  return state.config.jobs.filter((job) => state.ran.has(job.id)).map((job) => job.block);
}

test('a second generate with no input change runs no job and rewrites no output', async (t: TestContext) => {
  const { config } = fixture(t);
  const first = await runPipeline(config);
  assert.deepEqual(ranBlocks(first), ['openapi-ts', 'model']);
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
  assert.deepEqual(ranBlocks(edited), ['model'], 'the OpenAPI job reads no model source');
  assert.match(fs.readFileSync(path.join(root, 'src/cart.model.generated.ts'), 'utf8'), /selected/);
  assert.deepEqual(ranBlocks(await runPipeline(config)), []);

  const api = path.join(root, 'api.json');
  fs.writeFileSync(api, JSON.stringify(JSON.parse(fs.readFileSync(api, 'utf8')), null, 4));
  assert.deepEqual(ranBlocks(await runPipeline(config)), ['openapi-ts', 'model'], 'the manifest the OpenAPI job writes is the same, the job after it still runs');
});

test('a deleted output reruns its job, and a changed option or golem code reruns the jobs it applies to', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  const companion = path.join(root, 'src/cart.model.generated.ts');
  const original = fs.readFileSync(companion, 'utf8');
  fs.rmSync(companion);
  assert.deepEqual(ranBlocks(await runPipeline(config)), ['model']);
  assert.equal(fs.readFileSync(companion, 'utf8'), original);

  const records = path.join(root, '.golem/jobs.json');
  const written = JSON.parse(fs.readFileSync(records, 'utf8')) as { jobs: Record<string, { golemCode: string }> };
  const modelsId = Object.keys(written.jobs).find((id) => id === 'model');
  assert.ok(modelsId, 'the model job has a record');
  written.jobs[modelsId].golemCode = 'other-golem-code-digest';
  fs.writeFileSync(records, JSON.stringify(written));
  assert.deepEqual(ranBlocks(await runPipeline(config)), ['model']);

  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('validation: true', 'validation: false'));
  assert.deepEqual(ranBlocks(await runPipeline(config)), ['openapi-ts', 'model']);
  assert.deepEqual(ranBlocks(await runPipeline(config)), []);
});

test('the mode of an openapi job is recorded with the job, and a mode change reruns that job', async (t: TestContext) => {
  // protects: T-695 a mode change reruns the openapi job
  const { root, config } = fixture(t);
  await runPipeline(config);
  const records = JSON.parse(fs.readFileSync(path.join(root, '.golem/jobs.json'), 'utf8')) as { jobs: Record<string, { options: string }> };
  const openapiId = Object.keys(records.jobs).find((id) => id.startsWith('openapi:'));
  assert.ok(openapiId, 'the openapi job has a record');
  assert.equal((JSON.parse(records.jobs[openapiId].options) as { mode: string }).mode, 'standalone');

  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('      name: Profile', '      name: Profile\n      mode: golem'));
  assert.deepEqual(ranBlocks(await runPipeline(config)), ['openapi-ts', 'model']);
  assert.deepEqual(ranBlocks(await runPipeline(config)), []);
});

test('a generated file or the codec key table edited by hand is restored by the next run, because its job is not current', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  for (const edited of ['src/cart.model.generated.ts', '.golem/codec-keys.json']) {
    const filename = path.join(root, edited);
    const original = fs.readFileSync(filename, 'utf8');
    fs.writeFileSync(filename, `${original}\n// edited by hand\n`);
    assert.deepEqual(ranBlocks(await runPipeline(config)), ['model'], edited);
    assert.equal(fs.readFileSync(filename, 'utf8'), original, edited);
    assert.deepEqual(ranBlocks(await runPipeline(config)), [], `${edited} is current again`);
  }
});

/** The plan entry of the fixture packages below: the block `{ output }` declares one job `generator:<output>` that writes the folder `output`. */
const GENERATOR_PLAN = `import path from 'node:path';
export const plan = {
  declare({ directory, block }) {
    const output = path.resolve(directory, block.output);
    return [{
      facts: { id: 'generator:' + block.output, outputs: [{ path: output, kind: 'folder' }], ownedRoots: [], inputFiles: [], inputFolders: [], readsProgram: false, provides: [], needs: [], hooks: [], watch: [] },
      options: { directory, output },
    }];
  },
};
`;

/** Installs `@fixture/<name>`, which registers the block `<name>`, with the source of its generator, and lists it in the package.json of `root`. */
function installGenerator(root: string, name: string, generator: string, version = '1.0.0'): void {
  const provider = path.join(root, 'node_modules/@fixture', name);
  fs.mkdirSync(provider, { recursive: true });
  fs.writeFileSync(path.join(provider, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, version, type: 'module', exports: { './plan': './plan.js', './generator': './generator.js' }, golem: { apiVersion: 2, block: name, plan: './plan', generator: './generator' } }));
  fs.writeFileSync(path.join(provider, 'plan.js'), GENERATOR_PLAN);
  fs.writeFileSync(path.join(provider, 'generator.js'), generator);
  listProjectDependencies(root, [`@fixture/${name}`]);
}

test('a job that edits an input after it read it runs again, because its record holds the digest from the read', async (t: TestContext) => {
  const root = createFixtureProject(t, 'golem-pipeline-read-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"read-fixture","type":"module"}');
  installGenerator(root, 'rewriter', `import fs from 'node:fs';
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
  fs.writeFileSync(path.join(root, 'golem.yaml'), ['version: 1', 'rewriter:', '  output: out', ''].join('\n'));
  const config = path.join(root, 'golem.yaml');
  assert.deepEqual([...(await runPipeline(config)).ran].length, 1);
  assert.deepEqual([...(await runPipeline(config)).ran].length, 1, 'the file changed after the job read it, so the second run is not a cache hit');
});

test('a watch run after a cached start reruns the job that reads an output of an edited, skipped job', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  fs.rmSync(path.join(root, 'src/cart.model.generated.ts'));
  const cachedStart = await runPipeline(config);
  assert.deepEqual(ranBlocks(cachedStart), ['model'], 'the OpenAPI job is skipped and has no result');
  assert.equal(cachedStart.results.size, 1);
  const api = path.join(root, 'api.json');
  fs.writeFileSync(api, JSON.stringify(JSON.parse(fs.readFileSync(api, 'utf8')), null, 4));
  const next = await runPipeline(config, { previous: cachedStart, changedInputs: [api] });
  assert.deepEqual(ranBlocks(next), ['openapi-ts', 'model'], 'the models job reads the manifest of the OpenAPI job');
});

test('check reports an unresolved parse call with its code and writes no file', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  fs.writeFileSync(path.join(root, 'src/use.ts'), "import { parse } from '@exprtlabs/golem/serde';\nexport const bad = parse<string | null>('{}');\n");
  const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
  const records = fs.readFileSync(path.join(root, '.golem/jobs.json'), 'utf8');
  await assert.rejects(runPipeline(config, { check: true }), /RUNM1066 \(.*src\/use\.ts:2:20\): parse type argument must be a single type name or typeof expression/);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).map(String).sort(), before);
  assert.equal(fs.readFileSync(path.join(root, '.golem/jobs.json'), 'utf8'), records);
});

test('removing the OpenAPI job reruns the models job that read its output instead of skipping it', async (t: TestContext) => {
  const { root, config } = fixture(t);
  await runPipeline(config);
  fs.writeFileSync(config, ['version: 1', 'validation: true', 'model: {}', ''].join('\n'));
  await assert.rejects(runPipeline(config), /Cannot find module|cannot find module|TS2307|sdk[\\/]index/);
  assert.equal(fs.existsSync(path.join(root, 'sdk/index.ts')), false);
});

/** A project with one third-party generator job that announces `input.txt` when it reads it, or reports it without announcing it. */
function generatorProject(t: TestContext, announce: boolean): { root: string; config: string; install: (version: string) => void } {
  const root = createFixtureProject(t, 'golem-pipeline-generator-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"generator-fixture","type":"module"}');
  const install = (version: string): void => {
    installGenerator(root, 'reader', `import fs from 'node:fs';
import path from 'node:path';
export const apiVersion = 1;
export function generate(context) {
  const input = path.join(context.directory, 'input.txt');
  ${announce ? 'context.onInput(input);' : ''}
  const notes = path.join(context.directory, 'notes');
  const text = fs.readFileSync(input, 'utf8') + (fs.existsSync(notes) ? fs.readFileSync(path.join(notes, 'a.txt'), 'utf8') : '');
  if (fs.existsSync(path.join(context.directory, 'touch.flag'))) { const later = new Date(Date.now() + 60000); fs.utimesSync(input, later, later); }
  return { apiVersion: 1, artifacts: [{ path: path.join(context.output, 'out.txt'), content: '# Generated by @fixture/reader. Do not edit.\\n' + text }], manifestPaths: [], watchInputs: fs.existsSync(notes) ? [input, notes] : [input] };
}
`, version);
  };
  install('1.0.0');
  fs.writeFileSync(path.join(root, 'input.txt'), 'x');
  fs.writeFileSync(path.join(root, 'golem.yaml'), ['version: 1', 'reader:', '  output: out', ''].join('\n'));
  return { root, config: path.join(root, 'golem.yaml'), install };
}

/** `generatorProject` whose job does not announce `input`, with `input` dated `past`: the case that digests it when the job returns. */
function unannouncedInputProject(t: TestContext): { root: string; config: string; input: string; past: Date } {
  const { root, config } = generatorProject(t, false);
  const input = path.join(root, 'input.txt');
  const past = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(input, past, past);
  return { root, config, input, past };
}

test('a new version of a generator package with the same code does not rerun its job', async (t: TestContext) => {
  const { config, install } = generatorProject(t, true);
  assert.equal((await runPipeline(config)).ran.size, 1);
  install('1.1.0');
  assert.equal((await runPipeline(config)).ran.size, 0);
});

test('a watch input the job did not announce is digested when the job returns, so the next run skips the job until the input changes', async (t: TestContext) => {
  // protects: T-383 an unannounced watch input no longer reruns its job every time
  const { root, config, input } = unannouncedInputProject(t);
  assert.equal((await runPipeline(config)).ran.size, 1);
  assert.equal((await runPipeline(config)).ran.size, 0);
  fs.writeFileSync(input, 'y');
  assert.equal((await runPipeline(config)).ran.size, 1);
  assert.match(fs.readFileSync(path.join(root, 'out/out.txt'), 'utf8'), /y$/);
});

test('a watch input the job did not announce and that changed while the job ran makes the next run run the job again', async (t: TestContext) => {
  // protects: T-383 an unannounced watch input touched during the run never leaves stale output skipped
  const { root, config, input, past } = unannouncedInputProject(t);
  fs.writeFileSync(path.join(root, 'touch.flag'), '');
  assert.equal((await runPipeline(config)).ran.size, 1, 'the job touches its input while it runs');
  fs.rmSync(path.join(root, 'touch.flag'));
  fs.utimesSync(input, past, past);
  assert.equal((await runPipeline(config)).ran.size, 1, 'the touched input left no digest to trust');
  assert.equal((await runPipeline(config)).ran.size, 0, 'a run with no touch records the digest');
});

test('a directory the job did not announce as an input makes its job run every time, so an edit of a file inside it is not missed', async (t: TestContext) => {
  // protects: T-383 an unannounced directory watch input never leaves stale output skipped
  const { root, config } = unannouncedInputProject(t);
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'notes/a.txt'), 'a');
  assert.equal((await runPipeline(config)).ran.size, 1);
  fs.writeFileSync(path.join(root, 'notes/a.txt'), 'b');
  assert.equal((await runPipeline(config)).ran.size, 1);
  assert.match(fs.readFileSync(path.join(root, 'out/out.txt'), 'utf8'), /xb$/);
});

test('a run that fails after a job wrote new output leaves that job to run again when its input returns', async (t: TestContext) => {
  // protects: T-167 a failed run leaves no stale job record
  const root = createFixtureProject(t, 'golem-pipeline-failed-run-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"failed-run-fixture","type":"module"}');
  for (const [name, body] of [
    ['first', "return { apiVersion: 1, artifacts: [{ path: path.join(context.output, 'out.txt'), content: '# Generated by @fixture/first. Do not edit.\\n' + text }], manifestPaths: [], watchInputs: [input] };"],
    ['second', "if (fs.existsSync(flag)) throw new Error('second job fails'); return { apiVersion: 1, artifacts: [{ path: path.join(context.output, 'out.txt'), content: '# Generated by @fixture/second. Do not edit.\\n' }], manifestPaths: [], watchInputs: [flag] };"],
  ] as const) {
    installGenerator(root, name, `import fs from 'node:fs';
import path from 'node:path';
export const apiVersion = 1;
export function generate(context) {
  const input = path.join(context.directory, 'input.txt');
  const flag = path.join(context.directory, 'fail.flag');
  context.onInput(input);
  context.onInput(flag);
  const text = fs.readFileSync(input, 'utf8');
  ${body}
}
`);
  }
  fs.writeFileSync(path.join(root, 'golem.yaml'), ['version: 1', 'first:', '  output: out-first', 'second:', '  output: out-second', ''].join('\n'));
  const config = path.join(root, 'golem.yaml');
  const first = path.join(root, 'out-first/out.txt');
  fs.writeFileSync(path.join(root, 'input.txt'), 'A');
  await runPipeline(config);
  assert.match(fs.readFileSync(first, 'utf8'), /A$/);

  fs.writeFileSync(path.join(root, 'input.txt'), 'B');
  fs.writeFileSync(path.join(root, 'fail.flag'), '');
  await assert.rejects(runPipeline(config), /second job fails/);
  assert.match(fs.readFileSync(first, 'utf8'), /B$/, 'the first job wrote its output before the second failed');

  fs.writeFileSync(path.join(root, 'input.txt'), 'A');
  fs.rmSync(path.join(root, 'fail.flag'));
  const state = await runPipeline(config);
  assert.equal([...state.ran].includes('generator:out-first'), true, 'the first job ran again');
  assert.match(fs.readFileSync(first, 'utf8'), /A$/, 'its output matches the reverted input');
});

test('a clean clone runs an OpenAPI job on the document that an earlier generator writes, and still rejects an input nothing produces', async (t: TestContext) => {
  // protects: T-168 a job that reads an earlier job's output builds on a clean clone
  const root = createFixtureProject(t, 'golem-pipeline-produced-input-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"produced-input-fixture","type":"module"}');
  linkGolemPackages(root, ['golem', 'golem-openapi']);
  copyFixtureFile(root, 'packed/profile/tsconfig.json', 'tsconfig.json');
  copyFixtureFile(root, 'packed/profile/api.json', 'spec-source.json');
  installGenerator(root, 'spec', `import fs from 'node:fs';
import path from 'node:path';
export const apiVersion = 1;
export function generate(context) {
  const source = path.join(context.directory, 'spec-source.json');
  context.onInput(source);
  const document = { ...JSON.parse(fs.readFileSync(source, 'utf8')), 'x-generator': '@fixture/spec' };
  return { apiVersion: 1, artifacts: [{ path: path.join(context.output, 'api.json'), content: JSON.stringify(document) }], manifestPaths: [], watchInputs: [source] };
}
`);
  const config = path.join(root, 'golem.yaml');
  const yaml = (input: string): string => ['version: 1', 'spec:', '  output: gen', 'openapi-ts:', '  sdks:', `    - input: ${input}`, '      output: sdk', '      name: Profile', ''].join('\n');
  fs.writeFileSync(config, yaml('gen/api.json'));
  assert.equal(fs.existsSync(path.join(root, 'gen/api.json')), false);
  assert.deepEqual([...(await runPipeline(config)).ran], ['generator:gen', 'openapi:sdk']);
  assert.equal(fs.existsSync(path.join(root, 'sdk/index.ts')), true);

  fs.writeFileSync(config, yaml('elsewhere/api.json'));
  await assert.rejects(runPipeline(config), /input file does not exist: .*elsewhere[\\/]api\.json/);
});

/**
 * A project whose golem.yaml lies in `pkg/`, a folder without a tsconfig.json. The golem.yaml names the tsconfig one folder up, which holds the
 * options the model source needs: a `paths` alias and bundler module resolution, which allows the extensionless import.
 */
function parentTsconfigProject(t: TestContext): { root: string; jobRoot: string; config: string } {
  const root = createFixtureProject(t, 'golem-parent-tsconfig-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"parent-tsconfig-fixture","type":"module"}');
  linkGolemPackages(root, ['golem', 'golem-model']);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      skipLibCheck: true,
      noEmit: true,
      paths: { '@lib/*': ['./pkg/src/lib/*'] },
    },
    include: ['pkg/src/**/*.ts'],
  }));
  const sourceRoot = path.join(root, 'pkg/src');
  fs.mkdirSync(path.join(sourceRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'lib/ids.ts'), 'export type Id = string;\n');
  fs.writeFileSync(path.join(sourceRoot, 'label.ts'), 'export type Label = string;\n');
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), [
    "import type { IModel } from '@exprtlabs/golem/model';",
    "import type { Id } from '@lib/ids';",
    "import type { Label } from './label';",
    'export type TItem = IModel<{ id: Id; label: Label }>;',
    '',
  ].join('\n'));
  const config = path.join(root, 'pkg/golem.yaml');
  fs.writeFileSync(config, 'version: 1\ntsconfig: ../tsconfig.json\nmodel: {}\n');
  return { root, jobRoot: path.join(root, 'pkg'), config };
}

/** Type-checks a file that assigns values to the generated `TItemFields`: the alias and the extensionless import resolve under the parent options, or both fields are `unknown` and the bad assignment compiles. */
async function assertItemFieldsTyped(jobRoot: string, root: string): Promise<void> {
  fs.writeFileSync(path.join(jobRoot, 'src/probe.ts'), [
    "import type { TItemFields } from './item.model.generated.js';",
    "export const good: TItemFields = { id: 'a', label: 'b' };",
    '// @ts-expect-error the fields are strings, not unknown',
    'export const bad: TItemFields = { id: 1, label: 2 };',
    '',
  ].join('\n'));
  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json', '--noEmit']);
}

test('a models job analyses with the tsconfig that golem.yaml names and warns of nothing', async (t: TestContext) => {
  const { root, jobRoot, config } = parentTsconfigProject(t);
  const binary = path.join(workspace, 'packages/golem/dist/bin/golem.js');
  const result = await command(root, process.execPath, [binary, 'generate', '--config', config]);
  // The alias and the extensionless import resolve only under the parent's options; without them both fields are `unknown`.
  await assertItemFieldsTyped(jobRoot, root);
  assert.equal(result.stderr, '');
});

/** The models job of the fixture, the config it came from, and a folder beside the project that the job does not own. */
function modelsJobWithSiblingFolder(t: TestContext): { config: ReturnType<typeof loadConfig>; job: ReturnType<typeof loadConfig>['jobs'][number]; shared: string } {
  const { root, config: file } = fixture(t);
  const shared = path.join(root, '..', `${path.basename(root)}-shared`);
  fs.mkdirSync(shared, { recursive: true });
  t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  const config = loadConfig(file);
  const job = config.jobs.find(candidate => candidate.id === 'model');
  assert.ok(job, 'the fixture has a models job');
  return { config, job, shared };
}

const COMPANION_TEXT = '// Generated by @exprtlabs/golem-model. Do not edit.\nexport {};\n';

test('a models job writes no file for a model source outside its root that its tsconfig includes', async (t: TestContext) => {
  const { config: loaded, shared } = modelsJobWithSiblingFolder(t);
  const root = loaded.directory;
  const config = loaded.configFile;
  linkProjectPackages(shared, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  fs.writeFileSync(path.join(shared, 'other.model.ts'), "import type { IObject } from '@exprtlabs/golem/model';\nexport type TOther = IObject<{ size: number }>;\n");
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, allowJs: true },
    include: ['src/**/*.ts', 'sdk/**/*.ts', `${path.relative(root, shared).split(path.sep).join('/')}/**/*.ts`],
  }));

  await runPipeline(config);

  assert.equal(fs.existsSync(path.join(root, 'src/cart.model.generated.ts')), true, 'the project own model is generated');
  assert.deepEqual(fs.readdirSync(shared).sort(), ['node_modules', 'other.model.ts']);
});

test('a models job does not write a generated file outside its root, even beside a model source', (t: TestContext) => {
  const { config, job, shared } = modelsJobWithSiblingFolder(t);
  fs.writeFileSync(path.join(shared, 'other.model.ts'), 'export type TOther = unknown;\n');
  const stray = path.join(shared, 'other.model.generated.ts');

  assert.throws(
    () => applyJob(config, loadInventory(config), job, [{ path: stray, content: COMPANION_TEXT }]),
    { message: `Generated output escapes the ${job.id} destination: ${path.relative(process.cwd(), stray)}` },
  );
  assert.equal(fs.existsSync(stray), false);
});
