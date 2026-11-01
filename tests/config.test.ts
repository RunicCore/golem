import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { resolveConfig, type GolemJob } from '#golem/config';
import { JobRuleError } from '#golem/job-rules';
import { PackageRegistryError } from '#golem/package-registry';
import { loadConfig } from './support/load-config.js';
import { YamlFileError } from '#golem/generator-api';
import { parseArguments } from '#golem/cli';
import { copyFixture, createFixtureProject, fixturePath } from './fixture-project.js';

/** What the scripted plan entry (`tests/fixtures/config/scripted-plan`) records in the options of each job. */
interface Seen {
  readonly seen: { readonly profile: unknown; readonly tsconfig: string; readonly exact?: boolean };
  readonly needed: Readonly<Record<string, unknown>>;
  readonly consumers: Readonly<Record<string, readonly string[]>>;
}

const optionsOf = (job: GolemJob | undefined): Seen => {
  assert.ok(job, 'the job exists');
  return job.options as Seen;
};

const BLOCKS: Readonly<Record<string, string>> = { '@fixture/shop': 'shop', '@fixture/host': 'host' };

/** A project whose golem.yaml holds `yaml` and whose app lists one package for each of `blocks`, each running the scripted plan entry. */
function project(t: TestContext, yaml: string, blocks: Readonly<Record<string, string>> = BLOCKS): { root: string; filename: string } {
  const root = createFixtureProject(t, 'golem-config-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: Object.fromEntries(Object.keys(blocks).map((name) => [name, '1.0.0'])) }));
  const template = JSON.parse(fs.readFileSync(path.join(fixturePath('config/scripted-plan'), 'package.json'), 'utf8')) as { golem: object };
  for (const [name, block] of Object.entries(blocks)) {
    const directory = path.join(root, 'node_modules', name);
    copyFixture(directory, 'config/scripted-plan');
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ ...template, name, golem: { ...template.golem, block } }));
  }
  const filename = path.join(root, 'golem.yaml');
  fs.writeFileSync(filename, yaml);
  return { root, filename };
}

const SHOP = (jobs: string): string => `shop:\n  jobs:\n${jobs}`;
const DOCS = SHOP('    - { id: docs, roots: [.] }\n');

test('the shared root keys are read by core and reach every plan entry, and a key outside the list is a block', async (t: TestContext) => {
  // protects: T-765 page "Root keys stay shared": version, tsconfig, validation, allowAny, exact, unknownFormats stay at the root
  const defaults = project(t, `version: 1\n${DOCS}`);
  const config = await loadConfig(defaults.filename);
  assert.deepEqual(config.profile, { validation: true, allowAny: false, unknownFormats: 'error' });
  assert.equal(config.tsconfig, path.join(defaults.root, 'tsconfig.json'));
  assert.deepEqual(optionsOf(config.jobs[0]).seen, { profile: config.profile, tsconfig: config.tsconfig });

  const explicit = project(t, `version: 1\nvalidation: sanity\nallowAny: true\nexact: false\nunknownFormats: warn\n${DOCS}`);
  const explicitConfig = await loadConfig(explicit.filename);
  assert.deepEqual(explicitConfig.profile, { validation: 'sanity', allowAny: true, unknownFormats: 'warn' });
  assert.deepEqual(optionsOf(explicitConfig.jobs[0]).seen, { profile: explicitConfig.profile, tsconfig: explicitConfig.tsconfig, exact: false });
});

test('a block that no installed package registers stops loading and lists the installed packages and their blocks', async (t: TestContext) => {
  // protects: T-765 page failure row: an unknown block lists the installed golem packages and their blocks (also the retired generators and section keys)
  for (const key of ['retiredOption', 'generators', 'models']) {
    const { filename } = project(t, `version: 1\n${key}: {}\n${DOCS}`);
    await assert.rejects(() => resolveConfig(filename), (error: unknown) => error instanceof PackageRegistryError
      && error.message === `No installed package registers the golem block "${key}". Installed golem packages and their blocks: @fixture/host (block host), @fixture/shop (block shop). A package that only devDependencies lists is gone after a production install.`, key);
  }
});

test('a config with no block, or only blocks that declare no job, stops loading', async (t: TestContext) => {
  // protects: T-765 a golem.yaml with nothing to run is refused with the packages it could use
  await assert.rejects(() => resolveConfig(project(t, 'version: 1\n').filename), { message: 'Configure at least one golem block. Installed golem packages and their blocks: @fixture/host (block host), @fixture/shop (block shop).' });
  await assert.rejects(() => resolveConfig(project(t, `version: 1\n${SHOP('    []\n')}`).filename), { message: 'Configure at least one job: the blocks of golem.yaml declare none.' });
  await assert.rejects(() => resolveConfig(project(t, 'version: 1\nshop: {}\n').filename), { name: 'TypeError' }, 'a block the plan entry cannot read is its own error');
});

test('a package that registers a block without a plan entry stops loading and names the package', async (t: TestContext) => {
  // protects: T-765 core reads a block only through the plan entry of its package
  const { root, filename } = project(t, 'version: 1\nbare: {}\n', {});
  fs.mkdirSync(path.join(root, 'node_modules/@fixture/bare'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/@fixture/bare/package.json'), JSON.stringify({ name: '@fixture/bare', version: '1.0.0', golem: { apiVersion: 2, block: 'bare' } }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@fixture/bare': '1.0.0' } }));
  await assert.rejects(() => resolveConfig(filename), { message: '@fixture/bare registers the golem block "bare" but declares no golem.plan entry, so golem cannot read its block.' });
});

test('plan pass 1 declares facts, pass 2 hands each job the contract values it needs, and the order comes from the pass-2 facts', async (t: TestContext) => {
  // protects: T-765 page "What a job declares": two passes, then the order; the golem SDK folders that the models job reads come from pass 2
  const { root, filename } = project(t, [
    'version: 1',
    'host:',
    '  jobs:',
    '    - { id: models, roots: [.], readsProgram: true, provides: [CodecsHost] }',
    SHOP('    - { id: sdk, needs: [CodecsHost], outputs: [{ path: sdk, kind: folder }] }'),
  ].join('\n'));

  const config = await loadConfig(filename);

  // The host block comes first in golem.yaml; the SDK runs first because the host reads the SDK folder, a fact that only pass 2 adds.
  assert.deepEqual(config.jobs.map((job) => [job.id, job.package, job.block]), [['sdk', '@fixture/shop', 'shop'], ['models', '@fixture/host', 'host']]);
  assert.deepEqual(config.jobPlan.order, ['sdk', 'models']);
  assert.deepEqual(config.jobPlan.providers, { CodecsHost: 'models' });
  assert.deepEqual(config.jobs[1]?.facts.inputFolders, [path.join(root, 'sdk')]);
  assert.deepEqual(config.contracts, { CodecsHost: { from: 'models', directory: root } });
  assert.deepEqual(optionsOf(config.jobs[0]).needed, { CodecsHost: { from: 'models', directory: root } });
  assert.deepEqual(optionsOf(config.jobs[1]).consumers, { CodecsHost: ['sdk'] });
});

test('the generic rules stop loading: a needed contract with no provider, an id declared twice, a root outside the tsconfig folder', async (t: TestContext) => {
  // protects: T-765 page failure rows: a missing contract names it; containment F-42 holds for a block's roots and outputs
  const missing = project(t, `version: 1\n${SHOP('    - { id: sdk, needs: [CodecsHost] }\n')}`);
  await assert.rejects(() => resolveConfig(missing.filename), (error: unknown) => error instanceof JobRuleError && error.rule === 'contract-missing' && error.message === 'Job sdk needs the contract CodecsHost, but no job provides it.');

  const twice = project(t, `version: 1\n${DOCS}host:\n  jobs:\n    - { id: docs }\n`);
  await assert.rejects(() => resolveConfig(twice.filename), { message: 'Job id docs is declared twice, by @fixture/shop and @fixture/host. A job id is unique in one golem.yaml.' });

  const outside = project(t, `version: 1\n${SHOP('    - { id: docs, roots: [..] }\n')}`);
  fs.mkdirSync(path.join(outside.root, 'pkg'));
  fs.writeFileSync(path.join(outside.root, 'pkg/golem.yaml'), `version: 1\n${SHOP('    - { id: docs, roots: [..] }\n')}`);
  await assert.rejects(() => resolveConfig(path.join(outside.root, 'pkg/golem.yaml')), (error: unknown) => error instanceof JobRuleError && error.rule === 'containment');
});

test('the tsconfig key names the project tsconfig, relative to golem.yaml, and defaults to the one beside it', async (t: TestContext) => {
  const { root, filename } = project(t, `version: 1\n${DOCS}`);
  assert.equal((await loadConfig(filename)).tsconfig, path.join(root, 'tsconfig.json'), 'a missing default tsconfig is not an error');

  fs.mkdirSync(path.join(root, 'app/configs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.base.json'), '{}');
  fs.writeFileSync(path.join(root, 'app/configs/tsconfig.app.json'), '{}');
  // The job root lies in the directory of the tsconfig the yaml names.
  for (const [value, expected, jobRoot] of [['app/configs/tsconfig.app.json', 'app/configs/tsconfig.app.json', 'app/configs'], ['./tsconfig.base.json', 'tsconfig.base.json', '.']] as const) {
    fs.writeFileSync(filename, `version: 1\ntsconfig: ${value}\n${SHOP(`    - { id: docs, roots: [${jobRoot}] }\n`)}`);
    const loaded = await loadConfig(filename);
    assert.equal(loaded.tsconfig, path.join(root, expected));
    // protects: T-480 every job reads the tsconfig of golem.yaml
    assert.equal(optionsOf(loaded.jobs[0]).seen.tsconfig, path.join(root, expected));
  }

  fs.mkdirSync(path.join(root, 'packages/api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'packages/api/golem.yaml'), `version: 1\ntsconfig: ../../tsconfig.json\n${DOCS}`);
  assert.equal((await loadConfig(path.join(root, 'packages/api/golem.yaml'))).tsconfig, path.join(root, 'tsconfig.json'));
});

test('the tsconfig key resolves the directory through links and keeps the file name', async (t: TestContext) => {
  const { root, filename } = project(t, `version: 1\ntsconfig: alias/tsconfig.json\n${SHOP('    - { id: docs, roots: [real] }\n')}`);
  fs.mkdirSync(path.join(root, 'real'));
  fs.writeFileSync(path.join(root, 'real/tsconfig.json'), '{}');
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'dir');
  assert.equal((await loadConfig(filename)).tsconfig, path.join(root, 'real/tsconfig.json'), 'a linked directory resolves');

  // A linked file keeps its own directory: the project is where the link is, not where it points.
  const linked = project(t, `version: 1\n${DOCS}`);
  fs.mkdirSync(path.join(linked.root, 'shared'));
  fs.writeFileSync(path.join(linked.root, 'shared/tsconfig.real.json'), '{}');
  fs.symlinkSync(path.join('shared', 'tsconfig.real.json'), path.join(linked.root, 'tsconfig.json'));
  assert.equal((await loadConfig(linked.filename)).tsconfig, path.join(linked.root, 'tsconfig.json'));
});

test('a tsconfig key must be a nonempty string that names an existing file', async (t: TestContext) => {
  for (const [value, error] of [
    ['3', /tsconfig must be a nonempty string/],
    ['""', /tsconfig must be a nonempty string/],
    ['missing.json', /tsconfig does not exist: .*missing\.json/],
    ['src', /tsconfig must be a file: .*src/],
  ] as const) {
    const { root, filename } = project(t, `version: 1\ntsconfig: ${value}\n${DOCS}`);
    fs.mkdirSync(path.join(root, 'src'));
    await assert.rejects(() => loadConfig(filename), error);
  }
  // A misspelled path is that, not a tsconfig the jobs happen to find elsewhere.
  const { root, filename } = project(t, `version: 1\ntsconfig: tsconfg.json\n${DOCS}`);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  for (const load of [loadConfig, resolveConfig]) await assert.rejects(() => load(filename), /tsconfig does not exist: .*tsconfg\.json/);
});

test('an output that the app imports lies inside the tsconfig directory, and nothing is written', async (t: TestContext) => {
  // protects: F-42 an output the app imports stays inside the tsconfig directory (T-182)
  const { root } = project(t, '');
  fs.mkdirSync(path.join(root, 'project'));
  fs.mkdirSync(path.join(root, 'outside'));
  const filename = path.join(root, 'project/golem.yaml');
  fs.writeFileSync(filename, `version: 1\n${SHOP('    - { id: models, outputs: [{ path: ../outside, kind: folder, importedByApp: true }] }\n')}`);
  await assert.rejects(() => resolveConfig(filename), (error: unknown) => error instanceof JobRuleError && error.rule === 'containment'
    && error.message === `Job models: output ${path.relative(process.cwd(), path.join(root, 'outside'))} is outside the tsconfig directory ${path.relative(process.cwd(), path.join(root, 'project'))}. Move it inside.`);
  assert.deepEqual(fs.readdirSync(path.join(root, 'outside')), []);
});

test('golem.yaml validation accepts true, false and sanity, defaults to true, and refuses any other value', async (t: TestContext) => {
  // protects: T-663 validation: sanity reaches the profile of every job; other values stop with the key and the allowed values
  const accepted: [string, boolean | 'sanity'][] = [['', true], ['validation: true\n', true], ['validation: false\n', false], ['validation: sanity\n', 'sanity']];
  for (const [line, level] of accepted) {
    const config = await loadConfig(project(t, `version: 1\n${line}${DOCS}`).filename);
    assert.equal(config.profile.validation, level, line || 'validation absent');
    assert.deepEqual(optionsOf(config.jobs[0]).seen.profile, config.profile, `the profile of the job for ${line || 'validation absent'}`);
  }
  for (const value of ['full', '"true"', '1', 'null', '[sanity]']) {
    const { filename } = project(t, `version: 1\nvalidation: ${value}\n${DOCS}`);
    await assert.rejects(() => loadConfig(filename), { name: 'TypeError', message: 'validation must be true, false or "sanity".' }, value);
  }
});

test('configuration errors reject a wrong version, wrong root values and duplicate keys', async (t: TestContext) => {
  const testCases: [string, RegExp][] = [
    ['version: 2\n', /version/],
    ['version: 1\nmobx: true\n', /mobx/],
    ['version: 1\nversion: 1\n', /unique/],
    ['version: 1\nallowAny: maybe\n', /allowAny must be a boolean/],
    ['version: 1\nexact: maybe\n', /exact must be a boolean/],
    ['version: 1\nunknownFormats: strict\n', /unknownFormats must be "warn" or "error"/],
  ];
  for (const [root, error] of testCases) {
    const { filename } = project(t, `${root}${DOCS}`);
    await assert.rejects(() => loadConfig(filename), error, root);
  }
});

test('a golem.yaml that is not YAML fails with its path relative to the working directory, the line, the column and the parse error as its cause', async (t: TestContext) => {
  // protects: T-311 a YAML parse error names the file
  const { filename } = project(t, `version: 1\nversion: 1\n${DOCS}`);
  await assert.rejects(() => loadConfig(filename), (error: unknown) => {
    assert.ok(error instanceof YamlFileError);
    assert.ok(error.message.startsWith(`${path.relative(process.cwd(), filename)}:2:1 `), error.message);
    assert.ok(error.cause instanceof YAML.YAMLParseError);
    return true;
  });
});

test('inputs are checked against the files on disk, and an input that an earlier job writes is not required to exist', async (t: TestContext) => {
  // protects: T-765 validateConfigInputs reads job facts, not job kinds
  const { root, filename } = project(t, `version: 1\n${SHOP([
    '    - { id: docs, outputs: [{ path: api/payments.yaml }] }',
    '    - { id: sdk, roots: [src], inputFiles: [api/payments.yaml], outputs: [{ path: sdk, kind: folder }] }',
  ].join('\n') + '\n')}`);
  await assert.rejects(() => loadConfig(filename), { message: `Job sdk: root does not exist: ${path.relative(process.cwd(), path.join(root, 'src'))}` });
  fs.mkdirSync(path.join(root, 'src'));
  assert.deepEqual((await loadConfig(filename)).jobs.map((job) => job.id), ['docs', 'sdk'], 'a clean clone has no api/payments.yaml until docs runs');

  fs.writeFileSync(filename, `version: 1\n${SHOP('    - { id: sdk, inputFiles: [api/payments.yaml] }\n')}`);
  await assert.rejects(() => loadConfig(filename), { message: `Job sdk: input file does not exist: ${path.relative(process.cwd(), path.join(root, 'api/payments.yaml'))}` });

  fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(filename, `version: 1\n${SHOP('    - { id: docs, outputs: [{ path: out, kind: file }] }\n')}`);
  await assert.rejects(() => loadConfig(filename), { message: `Job docs: output must be a file: ${path.relative(process.cwd(), path.join(root, 'out'))}` });
});

test('CLI rejects per-command feature overrides and preserves child arguments', () => {
  assert.throws(() => parseArguments(['generate', '--mobx']), /Unknown option/);
  assert.deepEqual(parseArguments(['exec', '--watch', '--config', 'other.yaml', '--', 'node', '-e', 'process.exit(7)']), {
    action: 'exec', config: 'other.yaml', watch: true, command: ['node', '-e', 'process.exit(7)'],
  });
});

test('a root that an earlier job writes into, or holds, need not exist; a root nothing writes must', async (t: TestContext) => {
  // protects: T-786 a writer of the file src/gen/a.model.ts makes the root src/gen of a later job, on a clean clone
  const { root, filename } = project(t, `version: 1\n${SHOP([
    '    - { id: writer, outputs: [{ path: src/gen/a.model.ts }] }',
    '    - { id: reader, roots: [src/gen], inputFiles: [src/gen/a.model.ts] }',
  ].join('\n') + '\n')}`);
  assert.deepEqual((await loadConfig(filename)).jobs.map((job) => job.id), ['writer', 'reader']);

  fs.writeFileSync(filename, `version: 1\n${SHOP([
    '    - { id: writer, outputs: [{ path: src/gen, kind: folder }] }',
    '    - { id: reader, roots: [src/gen/deep] }',
  ].join('\n') + '\n')}`);
  assert.deepEqual((await loadConfig(filename)).jobs.map((job) => job.id), ['writer', 'reader'], 'a folder that holds the root');

  fs.writeFileSync(filename, `version: 1\n${SHOP([
    '    - { id: writer, outputs: [{ path: src/gen/a.model.ts }] }',
    '    - { id: reader, roots: [src/other] }',
  ].join('\n') + '\n')}`);
  await assert.rejects(() => loadConfig(filename), { message: `Job reader: root does not exist: ${path.relative(process.cwd(), path.join(root, 'src/other'))}` });
});

test('a provider of the model boundary that leaves out the suffixes stops loading and names the package', async (t: TestContext) => {
  // protects: T-786 core owns the ModelBoundary value, so a JS provider that omits suffixes fails at load, not later with a TypeError
  const { filename } = project(t, `version: 1\n${SHOP('    - { id: models, provides: [ModelBoundary], noSuffixes: true }\n')}`);
  await assert.rejects(() => loadConfig(filename), (error: unknown) => error instanceof PackageRegistryError && /^Job models of @fixture\/shop provides the contract ModelBoundary whose value must hold "suffixes", an array of strings\.$/.test(error.message));
});
