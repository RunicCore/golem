import { copyFixtureFile, createFixtureProject, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadConfig } from './support/load-config.js';
import { runPipeline } from '#golem/cli';
import { applyJob, digest, loadInventory, removeRetiredJobs } from '#golem/outputs';
import { strongestInputKind } from '#golem/pipeline';
import type { GolemConfig, GolemJob } from '#golem/config';
import { sourceInvalidationModule } from './fixture-templates/controllers/source-invalidation.js';
import { configFor } from './support/output-config.js';
import { workspace } from './support/process.js';

// Fake providers carry the workspace release version so the runtime version check accepts them.
function workspaceReleaseVersion(): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(workspace, 'packages/golem/package.json'), 'utf8')) as { version: string };
  return version;
}

function fixture(t: TestContext): { root: string; config: string } {
  const root = createFixtureProject(t, 'golem-controllers-');
  writeGeneratedArtifacts([{
    path: path.join(root, 'src/app.controller.ts'),
    content: 'export class AppController {}\n',
  }]);
  const config = path.join(root, 'golem.yaml');
  return { root, config };
}

function writeConfig(filename: string, body: string): void {
  fs.writeFileSync(filename, [
    'version: 1',
    'mobx: false',
    'validation: true',
    body,
    '',
  ].join('\n'));
}

function installProvider(root: string, result: Record<string, unknown>): void {
  const packageRoot = path.join(root, 'node_modules/@exprtlabs/golem-ts-openapi');
  writeGeneratedArtifacts([
    {
      path: path.join(packageRoot, 'package.json'),
      content: JSON.stringify({
        name: '@exprtlabs/golem-ts-openapi',
        version: workspaceReleaseVersion(),
        type: 'module',
        exports: { './generator': './generator.js' },
      }),
    },
    {
      path: path.join(packageRoot, 'provider-result.json'),
      content: JSON.stringify(result),
    },
  ]);
  copyFixtureFile(root, 'controllers/tooling/static-result-provider/generator.js', 'node_modules/@exprtlabs/golem-ts-openapi/generator.js');
}

type PipelineProviderOptions =
  | { readonly fixture: 'pipeline-controller-output' | 'pipeline-sdk-output'; readonly logPath: string }
  | { readonly fixture: 'invalidation-controller'; readonly logPath: string; readonly orderLogPath: string; readonly sharedInputPath: string }
  | { readonly fixture: 'invalidation-sdk'; readonly logPath: string; readonly orderLogPath: string };

function installPipelineProvider(
  root: string,
  packageName: string,
  options: PipelineProviderOptions,
): void {
  const packageRoot = path.join(root, 'node_modules', ...packageName.split('/'));
  const { fixture: providerFixture, ...providerOptions } = options;
  writeGeneratedArtifacts([
    {
      path: path.join(packageRoot, 'package.json'),
      content: JSON.stringify({
        name: packageName,
        version: workspaceReleaseVersion(),
        type: 'module',
        exports: { './generator': './generator.js' },
      }),
    },
    {
      path: path.join(packageRoot, 'provider-options.json'),
      content: JSON.stringify(providerOptions),
    },
  ]);
  copyFixtureFile(root, `controllers/tooling/${providerFixture}/generator.js`, `node_modules/${packageName}/generator.js`);
}

test('controller output resolves as an upstream input in config', (t: TestContext) => {
  const { root, config } = fixture(t);
  writeConfig(config, [
    'controllers:',
    '  - root: .',
    '    sources:',
    '      - src/app.controller.ts',
    '    output: generated/api.json',
    '    info:',
    '      title: Test API',
    '      version: "1"',
    'openapi:',
    '  - input: generated/api.json',
    '    output: sdk',
    'models:',
    '  root: .',
  ].join('\n'));

  const resolved = loadConfig(config);
  assert.deepEqual(resolved.jobs.map(job => job.kind), ['controllers', 'openapi', 'models']);
  const controller = resolved.jobs[0];
  assert.ok(controller && controller.kind === 'controllers');
  assert.equal(controller.package, '@exprtlabs/golem-ts-openapi');
  assert.equal(controller.options.openapiVersion, '3.2.0');
  assert.equal(controller.options.output, path.join(root, 'generated/api.json'));
  const sdk = resolved.jobs[1];
  assert.ok(sdk && sdk.kind === 'openapi');
  assert.equal(sdk.options.input, controller.options.output);
});

test('controller context validates URI versioning and preserves document tags', (t: TestContext) => {
  const { config } = fixture(t);
  writeConfig(config, [
    'controllers:',
    '  - root: .',
    '    output: generated/api.json',
    '    info: {title: Test API, version: "1"}',
    '    tags:',
    '      - name: health',
    '        description: Health endpoints',
    '    uriVersioning:',
    '      type: URI',
    '      prefix: v',
    '      defaultVersion: ["1", "2"]',
  ].join('\n'));
  const job = loadConfig(config).jobs[0];
  assert.ok(job && job.kind === 'controllers');
  assert.deepEqual(job.options.tags, [{ name: 'health', description: 'Health endpoints' }]);
  assert.deepEqual(job.options.uriVersioning, { type: 'URI', prefix: 'v', defaultVersion: ['1', '2'] });
});

test('shared input dependency classification preserves the strongest upstream job', () => {
  assert.equal(strongestInputKind('models', 'controllers'), 'controllers');
  assert.equal(strongestInputKind('controllers', 'models'), 'controllers');
  assert.equal(strongestInputKind('openapi', 'models'), 'openapi');
  assert.equal(strongestInputKind('config', 'controllers'), 'config');
});

test('controller error diagnostics block exact-file writes while warnings remain typed in the result', async (t: TestContext) => {
  const failing = fixture(t);
  writeConfig(failing.config, [
    'controllers:',
    '  - root: .',
    '    output: generated/api.json',
    '    info: {title: Test API, version: "1"}',
  ].join('\n'));
  const failingOutput = path.join(failing.root, 'generated/api.json');
  installProvider(failing.root, {
    apiVersion: 1,
    artifacts: [{
      path: failingOutput,
      content: '/* Generated by @exprtlabs/golem-ts-openapi. Do not edit. */\n{}\n',
    }],
    manifestPaths: [],
    watchInputs: [path.join(failing.root, 'src/app.controller.ts')],
    diagnostics: [{ severity: 'error', code: 'TSOA1001', message: 'unsupported route' }],
  });
  await assert.rejects(() => runPipeline(failing.config), /TSOA1001.*unsupported route/);
  assert.equal(fs.existsSync(failingOutput), false);
  assert.equal(fs.existsSync(path.join(failing.root, '.golem/outputs.json')), false);

  const warning = fixture(t);
  writeConfig(warning.config, [
    'controllers:',
    '  - root: .',
    '    output: generated/api.json',
    '    info: {title: Test API, version: "1"}',
  ].join('\n'));
  const warningOutput = path.join(warning.root, 'generated/api.json');
  installProvider(warning.root, {
    apiVersion: 1,
    artifacts: [{
      path: warningOutput,
      content: '/* Generated by @exprtlabs/golem-ts-openapi. Do not edit. */\n{}\n',
    }],
    manifestPaths: [],
    watchInputs: [path.join(warning.root, 'src/app.controller.ts')],
    diagnostics: [{ severity: 'warning', code: 'TSOA2001', message: 'custom rule omitted' }],
  });
  const state = await runPipeline(warning.config);
  assert.equal(fs.existsSync(warningOutput), true);
  const result = state.results.get('controllers:generated/api.json');
  assert.deepEqual(result?.diagnostics, [{ severity: 'warning', code: 'TSOA2001', message: 'custom rule omitted' }]);
  const inventory = JSON.parse(fs.readFileSync(path.join(warning.root, '.golem/outputs.json'), 'utf8')) as {
    files: Record<string, { owner: string; job: string; digest: string; destination: string }>;
  };
  const { digest: recordedDigest, ...recordedEntry } = inventory.files['generated/api.json'] ?? {};
  assert.deepEqual(recordedEntry, {
    owner: '@exprtlabs/golem-ts-openapi',
    job: 'controllers:generated/api.json',
    destination: 'generated/api.json',
    destinationKind: 'file',
  });
  assert.equal(recordedDigest, digest('/* Generated by @exprtlabs/golem-ts-openapi. Do not edit. */\n{}\n'));
});

test('controller OpenAPI files stay standards-valid while ownership and retirement remain guarded', (t: TestContext) => {
  const { root } = fixture(t);
  const output = path.join(root, 'generated/api.json');
  const job: GolemJob = {
    id: 'controllers:generated/api.json',
    kind: 'controllers',
    package: '@exprtlabs/golem-ts-openapi',
    options: {
      root,
      output,
      info: { title: 'Test API', version: '1' },
      profile: { mobx: false, validation: true },
    },
  };
  const config = configFor(root, job);
  const content = '{"x-generator":"@exprtlabs/golem-ts-openapi","openapi":"3.2.0","info":{"title":"Test API","version":"1"},"paths":{}}\n';
  applyJob(config, loadInventory(config), job, [{ path: output, content }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
    'x-generator': '@exprtlabs/golem-ts-openapi', openapi: '3.2.0', info: { title: 'Test API', version: '1' }, paths: {},
  });

  const retiredConfig: GolemConfig = { ...config, jobs: [] };
  assert.throws(() => removeRetiredJobs(retiredConfig, loadInventory(config), true), /removed jobs/);
  assert.equal(fs.existsSync(output), true);
  removeRetiredJobs(retiredConfig, loadInventory(config), false);
  assert.equal(fs.existsSync(output), false);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, '{"user":true}\n');
  assert.throws(
    () => applyJob(config, loadInventory(config), job, [{ path: output, content }]),
    /Refusing to overwrite .*generated\/api\.json: it was not generated by @exprtlabs\/golem-ts-openapi/,
  );
  assert.equal(fs.readFileSync(output, 'utf8'), '{"user":true}\n');
});

test('controller maxResultBytes from golem.yaml reaches the job options and must be a positive integer', (t: TestContext) => {
  // protects: T-376 golem.yaml sets the route result limit; the job options, and so the job hash, carry it
  const { config } = fixture(t);
  const job = (value: number): string => `controllers:\n  - root: .\n    output: api.json\n    info: { title: Test, version: "1" }\n    maxResultBytes: ${value}`;
  writeConfig(config, job(2097152));
  const loaded = loadConfig(config).jobs[0];
  assert.ok(loaded && loaded.kind === 'controllers');
  assert.equal(loaded.options.maxResultBytes, 2097152);
  writeConfig(config, job(0));
  assert.throws(() => loadConfig(config), /controllers\[0\]\.maxResultBytes must be a positive safe integer/);
});

test('pipeline executes controller output before the SDK consumes its exact file', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const controllerOutput = path.join(root, 'generated/api.json');
  const sdkOutput = path.join(root, 'sdk');
  writeConfig(config, [
    'controllers:',
    '  - root: .',
    '    output: generated/api.json',
    '    info: {title: Test API, version: "1"}',
    'openapi:',
    '  - input: generated/api.json',
    '    output: sdk',
  ].join('\n'));
  installPipelineProvider(
    root,
    '@exprtlabs/golem-ts-openapi',
    { fixture: 'pipeline-controller-output', logPath: path.join(root, 'provider-order.log') },
  );
  installPipelineProvider(
    root,
    '@exprtlabs/golem-openapi',
    { fixture: 'pipeline-sdk-output', logPath: path.join(root, 'provider-order.log') },
  );

  const state = await runPipeline(config);
  assert.equal(fs.readFileSync(path.join(root, 'provider-order.log'), 'utf8'), 'controller,sdk,');
  assert.equal(fs.existsSync(controllerOutput), true);
  assert.equal(fs.existsSync(path.join(sdkOutput, 'index.ts')), true);
  assert.equal(state.inputs.get(root), 'controllers');
});


test('controller framework accepts NestJS and rejects unsupported adapters before generation', t => {
  const { config } = fixture(t);
  const configuration = (framework: string): string => `controllers:
  - framework: ${framework}
    root: .
    output: api.yaml
    info: { title: Test, version: '1' }`;
  writeConfig(config, configuration('nestjs'));
  assert.equal(loadConfig(config).jobs[0].kind, 'controllers');
  writeConfig(config, configuration('express'));
  assert.throws(() => loadConfig(config), /framework must be nestjs/);
});

test('controller output extensions, cycles and collisions fail before providers run', t => {
  const { config } = fixture(t);
  const job = (output: string, extra = '') => `controllers:
  - root: .
    output: ${output}
    info: {title: Test, version: '1'}
${extra}`;
  writeConfig(config, job('api.txt'));
  assert.throws(() => loadConfig(config), /JSON or YAML/);
  writeConfig(config, job('api.yaml', '    sources: [api.yaml]'));
  assert.throws(() => loadConfig(config), /cycle|own generated output/i);
  writeConfig(config, job('sdk/api.yaml', 'openapi:\n  - input: sdk/api.yaml\n    output: sdk'));
  assert.throws(() => loadConfig(config), /Overlapping .*outputs/);
});

test('retired controller inventories reject sibling and descendant file ownership', async t => {
  const { root, config } = fixture(t);
  writeConfig(config, `controllers:
  - root: .
    output: api/openapi.json
    info: {title: Test, version: '1'}`);
  const resolved = loadConfig(config);
  const directory = path.dirname(resolved.inventoryFile);
  fs.mkdirSync(directory, { recursive: true });
  for (const key of ['api/notes.json', 'api/openapi.json/child.json']) {
    fs.writeFileSync(resolved.inventoryFile, JSON.stringify({ version: 1, files: {
      [key]: { job: 'controllers:api/openapi.json', owner: '@exprtlabs/golem-ts-openapi', digest: '0'.repeat(64), destination: 'api/openapi.json', destinationKind: 'file' },
    } }));
    assert.throws(() => loadInventory(resolved), /exact file destination/);
  }
  // A recorded file destination must be the configured document.
  fs.writeFileSync(resolved.inventoryFile, JSON.stringify({ version: 1, files: {
    'api/notes.json': { job: 'controllers:api/openapi.json', owner: '@exprtlabs/golem-ts-openapi', digest: '0'.repeat(64), destination: 'api/notes.json', destinationKind: 'file' },
  } }));
  assert.throws(() => loadInventory(resolved), /exact file destination/);
  const job = resolved.jobs[0];
  for (const written of ['api/notes.json', 'api/openapi.json/child.json']) {
    assert.throws(() => applyJob(resolved, { version: 1, files: {} }, job, [{
      path: path.join(root, written),
      content: '{"x-generator":"@exprtlabs/golem-ts-openapi"}',
    }]), /escapes the controllers:api\/openapi\.json destination/, written);
  }
});

test('source invalidation regenerates its controller consumers and SDKs without rerunning unrelated controller jobs', async t => {
  const { root, config } = fixture(t);
  for (const name of ['one', 'two', 'shared']) {
    fs.writeFileSync(path.join(root, `src/${name}.ts`), sourceInvalidationModule({ value: name }).text);
  }
  writeConfig(config, `controllers:
  - root: .
    sources: [src/one.ts]
    output: api/one.json
    info: { title: One, version: '1' }
  - root: .
    sources: [src/two.ts]
    output: api/two.json
    info: { title: Two, version: '1' }
openapi:
  - input: api/one.json
    output: sdk/one
  - input: api/two.json
    output: sdk/two`);
  installPipelineProvider(root, '@exprtlabs/golem-ts-openapi', {
    fixture: 'invalidation-controller',
    logPath: path.join(root, 'jobs.log'),
    orderLogPath: path.join(root, 'provider-order.log'),
    sharedInputPath: path.join(root, 'src/shared.ts'),
  });
  installPipelineProvider(root, '@exprtlabs/golem-openapi', {
    fixture: 'invalidation-sdk',
    logPath: path.join(root, 'jobs.log'),
    orderLogPath: path.join(root, 'provider-order.log'),
  });
  const initial = await runPipeline(config);
  const log = path.join(root, 'jobs.log');
  fs.writeFileSync(log, '');
  const next = await runPipeline(config, { previous: initial, changedInputs: [path.join(root, 'src/one.ts')] });
  assert.equal(fs.readFileSync(log, 'utf8'), 'One,SDK-one,');
  fs.writeFileSync(log, '');
  await runPipeline(config, { previous: next, changedInputs: [path.join(root, 'src/shared.ts')] });
  assert.equal(fs.readFileSync(log, 'utf8'), 'One,Two,SDK-one,SDK-two,');
  fs.writeFileSync(log, '');
  await runPipeline(config, { previous: next, changedInputs: [path.join(root, 'api/one.json')] });
  assert.equal(fs.readFileSync(log, 'utf8'), 'SDK-one,');
});
