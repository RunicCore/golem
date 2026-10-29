import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { resolveConfig } from '#golem/config';
import { loadConfig } from './support/load-config.js';
import { YamlFileError } from '#golem/generator-api';
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
  assert.deepEqual(config.profile, { mobx: false, validation: true, allowAny: false, unknownFormats: 'error' });
  assert.equal(config.nonModelInputs, 'error');
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
    'allowAny: true',
    'unknownFormats: warn',
    'nonModelInputs: warn',
    'models:',
    '  root: project',
    '  output: generated/models',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(explicit.root, 'project'), { recursive: true });
  const explicitConfig = loadConfig(explicit.filename);
  assert.deepEqual(explicitConfig.profile, { mobx: true, validation: true, allowAny: true, unknownFormats: 'warn' });
  assert.equal(explicitConfig.nonModelInputs, 'warn');
  const modelJob = explicitConfig.jobs.find((job) => job.kind === 'models');
  assert.ok(modelJob && modelJob.kind === 'models');
  assert.equal(modelJob.options.root, path.join(explicit.root, 'project'));
  assert.equal(modelJob.options.output, path.join(explicit.root, 'generated/models'));
  assert.deepEqual(modelJob.options.profile, explicitConfig.profile);
});

test('the tsconfig key names the project tsconfig, relative to golem.yaml, and defaults to the one beside it', (t: TestContext) => {
  const { root, filename } = fixture(t, 'version: 1\nmodels:\n  root: .\n');
  const config = loadConfig(filename);
  assert.equal(config.tsconfig, path.join(root, 'tsconfig.json'), 'a missing default tsconfig is not an error');

  fs.mkdirSync(path.join(root, 'app/configs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.base.json'), '{}');
  fs.writeFileSync(path.join(root, 'app/configs/tsconfig.app.json'), '{}');
  // The job root lies in the directory of the tsconfig the yaml names.
  for (const [value, expected, jobRoot] of [['app/configs/tsconfig.app.json', 'app/configs/tsconfig.app.json', 'app/configs'], ['./tsconfig.base.json', 'tsconfig.base.json', '.']] as const) {
    const named = fixture(t, `version: 1\ntsconfig: ${value}\nmodels:\n  root: ${jobRoot}\n`);
    fs.cpSync(root, named.root, { recursive: true, filter: (source) => !source.endsWith('golem.yaml') });
    const loaded = loadConfig(named.filename);
    assert.equal(loaded.tsconfig, path.join(named.root, expected));
  }

  const parent = fixture(t, 'version: 1\nmodels:\n  root: .\n');
  fs.mkdirSync(path.join(parent.root, 'packages/api'), { recursive: true });
  fs.writeFileSync(path.join(parent.root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(parent.root, 'packages/api/golem.yaml'), 'version: 1\ntsconfig: ../../tsconfig.json\nmodels:\n  root: .\n');
  assert.equal(loadConfig(path.join(parent.root, 'packages/api/golem.yaml')).tsconfig, path.join(parent.root, 'tsconfig.json'));
});

test('the tsconfig key resolves the directory through links and keeps the file name', (t: TestContext) => {
  const { root, filename } = fixture(t, 'version: 1\ntsconfig: alias/tsconfig.json\nmodels:\n  root: alias\n');
  fs.mkdirSync(path.join(root, 'real'));
  fs.writeFileSync(path.join(root, 'real/tsconfig.json'), '{}');
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'dir');
  assert.equal(loadConfig(filename).tsconfig, path.join(root, 'real/tsconfig.json'), 'a linked directory resolves');

  // A linked file keeps its own directory: the project is where the link is, not where it points.
  const linked = fixture(t, 'version: 1\nmodels:\n  root: .\n');
  fs.mkdirSync(path.join(linked.root, 'shared'));
  fs.writeFileSync(path.join(linked.root, 'shared/tsconfig.real.json'), '{}');
  fs.symlinkSync(path.join('shared', 'tsconfig.real.json'), path.join(linked.root, 'tsconfig.json'));
  assert.equal(loadConfig(linked.filename).tsconfig, path.join(linked.root, 'tsconfig.json'));
});

test('a tsconfig key must be a nonempty string that names an existing file', (t: TestContext) => {
  for (const [yaml, error] of [
    ['version: 1\ntsconfig: 3\nmodels: {}\n', /tsconfig must be a nonempty string/],
    ['version: 1\ntsconfig: ""\nmodels: {}\n', /tsconfig must be a nonempty string/],
    ['version: 1\ntsconfig: missing.json\nmodels: {}\n', /tsconfig does not exist: .*missing\.json/],
    ['version: 1\ntsconfig: src\nmodels: {}\n', /tsconfig must be a file: .*src/],
  ] as const) {
    const { root, filename } = fixture(t, yaml);
    fs.mkdirSync(path.join(root, 'src'));
    assert.throws(() => loadConfig(filename), error);
  }
});

test('a misspelled tsconfig path reports that the file does not exist, not the tsconfig the job finds', (t: TestContext) => {
  const { root, filename } = fixture(t, 'version: 1\ntsconfig: tsconfg.json\nmodels:\n  root: .\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  for (const load of [loadConfig, resolveConfig]) assert.throws(() => load(filename), /tsconfig does not exist: .*tsconfg\.json/);
});

test('a models or controllers job root must lie inside the directory of the yaml tsconfig, and other outputs may be anywhere', (t: TestContext) => {
  const controllers = 'controllers:\n  - root: other\n    output: api.json\n    info: { title: Api, version: "1" }\n';
  const layouts = [
    // The tsconfig key puts the project directory below the job root.
    { yaml: `version: 1\ntsconfig: app/tsconfig.json\nmodels:\n  root: other\n`, directory: '.', project: 'app', jobRoot: 'other' },
    { yaml: `version: 1\ntsconfig: app/tsconfig.json\n${controllers}`, directory: '.', project: 'app', jobRoot: 'other' },
    // The default tsconfig sits beside the yaml: a root above it is outside.
    { yaml: 'version: 1\nmodels:\n  root: ..\n', directory: 'pkg', project: 'pkg', jobRoot: '.' },
  ] as const;
  for (const layout of layouts) {
    const { root } = fixture(t, layout.yaml);
    for (const directory of ['app', 'other', 'pkg']) {
      fs.mkdirSync(path.join(root, directory));
      fs.writeFileSync(path.join(root, directory, 'tsconfig.json'), '{}');
    }
    const filename = path.join(root, layout.directory, 'golem.yaml');
    fs.writeFileSync(filename, layout.yaml);
    assert.throws(() => loadConfig(filename), (error: Error) => {
      assert.equal(error.message, `job root ${path.relative(process.cwd(), path.join(root, layout.jobRoot))} is outside ${path.relative(process.cwd(), path.join(root, layout.project))}; use one golem.yaml per tsconfig.`);
      return true;
    });
  }

  // A root inside the directory is fine, and so is an openapi output outside it.
  const inside = fixture(t, 'version: 1\ntsconfig: app/tsconfig.json\nopenapi:\n  - input: api.yaml\n    output: sdk\nmodels:\n  root: app/nested\n');
  fs.mkdirSync(path.join(inside.root, 'app/nested'), { recursive: true });
  fs.writeFileSync(path.join(inside.root, 'app/tsconfig.json'), '{}');
  assert.equal(loadConfig(inside.filename).jobs.length, 2);
});

// protects: F-42 the models output stays inside the tsconfig directory (T-182)
for (const [name, output, resolved] of [
  ['a models output', '../outside', 'outside'],
  ['a models output behind a link to a folder', 'linked/models', 'outside/models'],
] as const) {
  test(`${name} outside the tsconfig directory stops loading and writes nothing`, (t: TestContext) => {
    const { root } = fixture(t, '');
    fs.mkdirSync(path.join(root, 'project'));
    fs.mkdirSync(path.join(root, 'outside'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'project/linked'), 'dir');
    const filename = path.join(root, 'project/golem.yaml');
    fs.writeFileSync(filename, `version: 1\nmodels:\n  root: .\n  output: ${output}\n`);
    assert.throws(() => loadConfig(filename), (error: Error) => {
      assert.equal(error.message, `Job models:.: output ${path.relative(process.cwd(), path.join(root, resolved))} is outside the tsconfig directory ${path.relative(process.cwd(), path.join(root, 'project'))}. Move it inside.`);
      return true;
    });
    assert.deepEqual(fs.readdirSync(path.join(root, 'outside')), []);
  });
}

test('a models or controllers job reads the tsconfig the yaml names, not the one nearer to its root', (t: TestContext) => {
  // protects: T-480 every job reads the tsconfig of golem.yaml
  const named = fixture(t, 'version: 1\ntsconfig: ./tsconfig.app.json\nmodels:\n  root: .\n');
  fs.writeFileSync(path.join(named.root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(named.root, 'tsconfig.app.json'), '{}');
  const [models] = loadConfig(named.filename).jobs;
  assert.equal(models!.kind === 'models' && models.options.tsconfig, path.join(named.root, 'tsconfig.app.json'));

  // A controllers job in a package with its own tsconfig, under the default tsconfig beside the yaml.
  const nested = fixture(t, 'version: 1\ncontrollers:\n  - root: packages/api\n    output: api.json\n    info: { title: Api, version: "1" }\n');
  fs.mkdirSync(path.join(nested.root, 'packages/api'), { recursive: true });
  fs.writeFileSync(path.join(nested.root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(nested.root, 'packages/api/tsconfig.json'), '{}');
  const [controllers] = loadConfig(nested.filename).jobs;
  assert.equal(controllers!.kind === 'controllers' && controllers.options.tsconfig, path.join(nested.root, 'tsconfig.json'));
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
    ['version: 1\nunknownFormats: strict\nmodels: {}\n', /unknownFormats must be "warn" or "error"/],
    ['version: 1\nnonModelInputs: strict\nmodels: {}\n', /nonModelInputs must be "warn" or "error"/],
    ['version: 1\nretiredOption: true\nmodels: {}\n', /Unknown configuration key: retiredOption\./],
    ['version: 1\nopenapi:\n  - input: api.yaml\n    output: sdk\n    retiredOption: true\n', /Unknown openapi\[0\] key/],
    ['version: 1\nopenapi:\n  - input: api.yaml\n    output: sdk\nmodels:\n  root: .\n  output: sdk/models\n', /Overlapping/],
    ['version: 1\nopenapi:\n  - input: api.yaml\n    output: src\nmodels:\n  root: .\n', /Overlapping/],
  ];
  for (const [yaml, error] of testCases) {
    const { filename } = fixture(t, yaml);
    assert.throws(() => loadConfig(filename), error);
  }
});

test('a golem.yaml that is not YAML fails with its path relative to the working directory, the line, the column and the parse error as its cause', (t: TestContext) => {
  // protects: T-311 a YAML parse error names the file
  const { filename } = fixture(t, 'version: 1\nversion: 1\nmodels: {}\n');
  assert.throws(() => loadConfig(filename), (error: unknown) => {
    assert.ok(error instanceof YamlFileError);
    assert.ok(error.message.startsWith(`${path.relative(process.cwd(), filename)}:2:1 `), error.message);
    assert.ok(error.cause instanceof YAML.YAMLParseError);
    return true;
  });
});

test('configured provider absence and incompatible API have distinct actionable errors', async (t: TestContext) => {
  const { root, filename } = fixture(t, 'version: 1\nmodels: {}\n');
  // The hint installs the generator from the same npm channel as the running golem (a stable version -> latest).
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

const CONTROLLER_YAML = (suffixes: string): string => `version: 1\ncontrollers:\n  - root: .\n    output: api.json\n    info: { title: T, version: "1" }\n    suffixes: ${suffixes}\n`;

test('model and controller suffixes are read per job, and a job without them has none', (t: TestContext) => {
  const models = fixture(t, 'version: 1\nmodels:\n  root: .\n  suffixes: [.entity.ts, .record.mts]\n');
  const modelJob = loadConfig(models.filename).jobs[0];
  assert.ok(modelJob && modelJob.kind === 'models');
  assert.deepEqual(Reflect.get(modelJob.options, 'suffixes'), ['.entity.ts', '.record.mts']);

  const controllers = fixture(t, CONTROLLER_YAML('[.api.ts]'));
  const controllerJob = loadConfig(controllers.filename).jobs[0];
  assert.ok(controllerJob && controllerJob.kind === 'controllers');
  assert.deepEqual(Reflect.get(controllerJob.options, 'suffixes'), ['.api.ts']);

  const defaults = fixture(t, 'version: 1\nmodels:\n  root: .\n');
  const defaultJob = loadConfig(defaults.filename).jobs[0];
  assert.ok(defaultJob && defaultJob.kind === 'models');
  assert.equal('suffixes' in defaultJob.options, false, 'the generator applies its own defaults');
});

test('a suffix that is empty, malformed, repeated or names a generated file is a configuration error', (t: TestContext) => {
  const models = (suffixes: string): string => `version: 1\nmodels:\n  root: .\n  suffixes: ${suffixes}\n`;
  const form = (label: string): string => `${label} must be a string that starts with "." and ends in .ts, .mts or .cts.`;
  const generated = (label: string): string => `${label} must not end in .generated.ts, .generated.mts or .generated.cts: golem writes those files.`;
  const testCases: [string, string][] = [
    [models('[]'), 'models.suffixes must be a nonempty array.'],
    [models('.model.ts'), 'models.suffixes must be a nonempty array.'],
    [models('[""]'), form('models.suffixes[0]')],
    [models('[.model.ts, model.ts]'), form('models.suffixes[1]')],
    [models('[.model.js]'), form('models.suffixes[0]')],
    [models('[.model.ts, 3]'), form('models.suffixes[1]')],
    [models('[.d.ts]'), 'models.suffixes[0] must not end in .d.ts, .d.mts or .d.cts: a declaration file cannot be a source.'],
    [models('[.model.generated.ts]'), generated('models.suffixes[0]')],
    [models('[.model.generated.cts]'), generated('models.suffixes[0]')],
    [models('[.model.ts, .models.ts, .model.ts]'), 'models.suffixes lists .model.ts twice.'],
    [CONTROLLER_YAML('[]'), 'controllers[0].suffixes must be a nonempty array.'],
    [CONTROLLER_YAML('[api.ts]'), form('controllers[0].suffixes[0]')],
    [CONTROLLER_YAML('[.api.generated.mts]'), generated('controllers[0].suffixes[0]')],
    [CONTROLLER_YAML('[.api.ts, .api.ts]'), 'controllers[0].suffixes lists .api.ts twice.'],
  ];
  for (const [yaml, message] of testCases) {
    const { filename } = fixture(t, yaml);
    assert.throws(() => loadConfig(filename), (error: unknown) => error instanceof Error && error.message === message, message);
  }
});

/** `fixture` with an empty tsconfig, an `app/src` folder for the models root, and `shared/money.model.ts` outside that root. */
function outsideRootFixture(t: TestContext, yaml: string): { root: string; filename: string } {
  const project = fixture(t, yaml);
  fs.writeFileSync(path.join(project.root, 'tsconfig.json'), '{}');
  fs.mkdirSync(path.join(project.root, 'app/src'), { recursive: true });
  fs.mkdirSync(path.join(project.root, 'shared'));
  fs.writeFileSync(path.join(project.root, 'shared/money.model.ts'), 'export {};\n');
  return project;
}

test('a models.sources entry outside models.root stops with RUNM1075 naming the entry and the root', (t: TestContext) => {
  // protects: T-375 a config error names its local files relative to the working directory
  const { root, filename } = outsideRootFixture(t, 'version: 1\nmodels:\n  root: app\n  sources: [shared/money.model.ts]\n');

  assert.throws(() => loadConfig(filename), (error: unknown) => error instanceof Error
    && error.message === `RUNM1075: models.sources entry ${path.relative(process.cwd(), path.join(root, 'shared/money.model.ts'))} is outside the models root ${path.relative(process.cwd(), path.join(root, 'app'))}. A models job generates only files inside its root.`);
});

test('a models.sources entry that links to a file outside the root stops with RUNM1075', (t: TestContext) => {
  const { root, filename } = outsideRootFixture(t, 'version: 1\nmodels:\n  root: app\n  sources: [app/src/money.model.ts]\n');
  fs.symlinkSync('../../shared/money.model.ts', path.join(root, 'app/src/money.model.ts'));

  assert.throws(() => loadConfig(filename), (error: unknown) => error instanceof Error
    && error.message === `RUNM1075: models.sources entry ${path.relative(process.cwd(), path.join(root, 'shared/money.model.ts'))} is outside the models root ${path.relative(process.cwd(), path.join(root, 'app'))}. A models job generates only files inside its root.`);
});
