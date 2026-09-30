import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '#golem/config';
import { parseArguments, providersFor } from '#golem/cli';

function fixture(t: TestContext, yaml: string): { root: string; filename: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'api.yaml'), 'openapi: 3.1.0');
  const filename = path.join(root, 'golem.yaml');
  fs.writeFileSync(filename, yaml);
  return { root, filename };
}

test('defaults and relative paths are anchored to the config rather than process cwd', (t: TestContext) => {
  const { root, filename } = fixture(t, 'version: 1\nopenapi:\n  - input: api.yaml\n    output: sdk\nmodels:\n  root: .\n');
  const config = loadConfig(filename);
  assert.deepEqual(config.profile, { mobx: false, validation: true, ajvStandalone: false, allowAny: false });
  const job0 = config.jobs[0];
  const job1 = config.jobs[1];
  assert.ok(job0 && job0.kind === 'openapi');
  assert.equal(job0.options.input, path.join(root, 'api.yaml'));
  assert.equal(job0.options.output, path.join(root, 'sdk'));
  assert.ok(job1 && job1.kind === 'models');
  assert.equal(job1.options.root, root);
  assert.equal(job1.options.output, path.join(root, 'src/generated/models'));

  const explicit = fixture(t, [
    'version: 1',
    'mobx: true',
    'validation: true',
    'ajvStandalone: true',
    'allowAny: true',
    'models:',
    '  root: project',
    '  output: generated/models',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(explicit.root, 'project'), { recursive: true });
  const explicitConfig = loadConfig(explicit.filename);
  assert.deepEqual(explicitConfig.profile, { mobx: true, validation: true, ajvStandalone: true, allowAny: true });
  const modelJob = explicitConfig.jobs.find((job) => job.kind === 'models');
  assert.ok(modelJob && modelJob.kind === 'models');
  assert.equal(modelJob.options.root, path.join(explicit.root, 'project'));
  assert.equal(modelJob.options.output, path.join(explicit.root, 'generated/models'));
  assert.deepEqual(modelJob.options.profile, explicitConfig.profile);
});

test('configuration errors reject unknown overrides, duplicate keys and overlapping outputs', (t: TestContext) => {
  const testCases: [string, RegExp][] = [
    ['version: 2\nmodels: {}', /version/],
    ['version: 1\nmobx: maybe\nmodels: {}', /boolean/],
    ['version: 1\nmodels: {mobx: true}', /Unknown models key/],
    ['version: 1\nversion: 1\nmodels: {}', /unique/],
    ['version: 1\nopenapi: [{input: api.yaml, output: sdk}, {input: api.yaml, output: sdk/nested}]', /Overlapping/],
    ['version: 1\nopenapi: [{input: api.yaml, output: sdk, allowRemoteRefs: true}]', /remoteHosts/],
    ['version: 1\nopenapi: [{input: api.yaml, output: sdk, maxRefBytes: 0}]', /positive/],
    ['version: 1\nallowAny: maybe\nmodels: {}\n', /allowAny must be a boolean/],
    ['version: 1\najvStandalone: maybe\nmodels: {}\n', /ajvStandalone must be a boolean/],
    ['version: 1\nopenapi:\n  - input: api.yaml\n    output: sdk\n    ajvStandalone: true\n', /Unknown openapi\[0\] key/],
    ['version: 1\nvalidation: false\najvStandalone: true\nopenapi:\n  - input: api.yaml\n    output: sdk\n', /ajvStandalone.*validation|validation.*ajvStandalone/],
    ['version: 1\nopenapi:\n  - input: api.yaml\n    output: sdk\nmodels:\n  root: .\n  output: sdk/models\n', /Overlapping/],
    ['version: 1\nopenapi:\n  - input: api.yaml\n    output: src\nmodels:\n  root: .\n', /Overlapping/],
  ];
  for (const [yaml, error] of testCases) {
    const { filename } = fixture(t, yaml);
    assert.throws(() => loadConfig(filename), error);
  }
});

test('configured provider absence and incompatible API have distinct actionable errors', async (t: TestContext) => {
  const { root, filename } = fixture(t, 'version: 1\nmodels: {}\n');
  // The hint installs the generator from the same npm channel as the running codegen (1.0.0-rc -> @rc).
  const { version } = JSON.parse(fs.readFileSync(new URL('../../packages/golem/package.json', import.meta.url), 'utf8')) as { version: string };
  const channel = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1] ?? 'latest';
  await assert.rejects(
    providersFor(loadConfig(filename)),
    (error: unknown) => error instanceof Error && error.message.includes('@exprtlabs/golem-model is not installed')
      && error.message.includes(`npm install -D @exprtlabs/golem-model@${channel}.`),
  );
  const provider = path.join(root, 'node_modules/@exprtlabs/golem-model');
  fs.mkdirSync(provider, { recursive: true });
  fs.writeFileSync(path.join(provider, 'package.json'), JSON.stringify({ name: '@exprtlabs/golem-model', version, type: 'module', exports: { './generator': './index.js' } }));
  fs.writeFileSync(path.join(provider, 'index.js'), 'export const apiVersion = 99;\nexport function generate() {}\n');
  await assert.rejects(providersFor(loadConfig(filename)), /CLI supports API 1.*99/);
});

test('output collision checking resolves directory aliases before generation', (t: TestContext) => {
  const { root, filename } = fixture(t, 'version: 1\nopenapi: [{input: api.yaml, output: sdk}, {input: api.yaml, output: alias/nested}]');
  fs.mkdirSync(path.join(root, 'sdk'));
  fs.symlinkSync(path.join(root, 'sdk'), path.join(root, 'alias'), 'dir');
  assert.throws(() => loadConfig(filename), /Overlapping/);
});

test('CLI rejects per-command feature overrides and preserves child arguments', () => {
  assert.throws(() => parseArguments(['generate', '--mobx']), /Unknown option/);
  assert.deepEqual(parseArguments(['exec', '--watch', '--config', 'other.yaml', '--', 'node', '-e', 'process.exit(7)']), {
    action: 'exec', config: 'other.yaml', watch: true, command: ['node', '-e', 'process.exit(7)'],
  });
});
