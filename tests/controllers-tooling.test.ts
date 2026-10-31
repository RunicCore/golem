import { copyFixture, createFixtureProject, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { loadConfig } from './support/load-config.js';
import { runPipeline } from '#golem/cli';
import { applyJob, digest, loadInventory, removeRetiredJobs } from '#golem/outputs';
import type { GolemConfig, GolemJob } from '#golem/config';
import { sourceInvalidationModule } from './fixture-templates/controllers/source-invalidation.js';
import { configFor, jobWithFacts } from './support/output-config.js';
import { workspace } from './support/process.js';

// Fake providers carry the workspace release version so the runtime version check accepts them.
function workspaceReleaseVersion(): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(workspace, 'packages/golem/package.json'), 'utf8')) as { version: string };
  return version;
}

/** A project with one controller source and a `boundary` package that provides ModelBoundary. The docs package is registered by `useDocsPackage` or `installProvider`. */
function fixture(t: TestContext): { root: string; config: string } {
  const root = createFixtureProject(t, 'golem-controllers-');
  writeGeneratedArtifacts([{
    path: path.join(root, 'src/app.controller.ts'),
    content: 'export class AppController {}\n',
  }, {
    path: path.join(root, 'package.json'),
    content: JSON.stringify({ name: 'app', dependencies: { '@exprtlabs/golem-ts-openapi': '*', '@exprtlabs/golem-openapi': '*', '@fixture/boundary': '*' } }),
  }]);
  copyFixture(path.join(root, 'node_modules/@fixture/boundary'), 'controllers/tooling/boundary-provider');
  return { root, config: path.join(root, 'golem.yaml') };
}

/** The real golem-ts-openapi package, linked into the project: its own plan entry reads the block. */
function useDocsPackage(root: string): void {
  const link = path.join(root, 'node_modules/@exprtlabs/golem-ts-openapi');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(workspace, 'packages/golem-ts-openapi'), link, 'dir');
}

function writeConfig(filename: string, body: string, boundary = 'boundary:\n  root: .\n'): void {
  fs.writeFileSync(filename, ['version: 1', 'mobx: false', 'validation: true', body, boundary].join('\n'));
}

/** A `ts-openapi` block with one docs job; `extra` lines belong to that job. */
function docs(output: string, extra = ''): string {
  return `ts-openapi:\n  docs:\n    - output: ${output}\n      info: { title: Test API, version: "1" }\n${extra}`;
}

/** A fake package for the block of `realPackage`: it runs the real plan entry of that package and the generator in `generatorFixture`. */
function installPackage(root: string, packageName: string, realPackage: string, block: string, generatorFixture: string, data: Record<string, unknown>, dataFile = 'provider-options.json'): void {
  const packageRoot = path.join(root, 'node_modules', ...packageName.split('/'));
  writeGeneratedArtifacts([
    {
      path: path.join(packageRoot, 'package.json'),
      content: JSON.stringify({
        name: packageName,
        version: workspaceReleaseVersion(),
        type: 'module',
        exports: { './plan': './plan.js', './generator': './generator.js' },
        golem: { apiVersion: 2, block, plan: './plan', generator: './generator' },
      }),
    },
    { path: path.join(packageRoot, 'plan.js'), content: `export { plan } from ${JSON.stringify(pathToFileURL(path.join(workspace, 'packages', realPackage, 'dist/plan.js')).href)};\n` },
    { path: path.join(packageRoot, dataFile), content: JSON.stringify(data) },
  ]);
  fs.copyFileSync(path.join(workspace, 'tests/fixtures/controllers/tooling', generatorFixture, 'generator.js'), path.join(packageRoot, 'generator.js'));
}

function installProvider(root: string, result: Record<string, unknown>): void {
  installPackage(root, '@exprtlabs/golem-ts-openapi', 'golem-ts-openapi', 'ts-openapi', 'static-result-provider', result, 'provider-result.json');
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
  const { fixture: providerFixture, ...providerOptions } = options;
  const docsPackage = packageName === '@exprtlabs/golem-ts-openapi';
  installPackage(root, packageName, docsPackage ? 'golem-ts-openapi' : 'golem-openapi', docsPackage ? 'ts-openapi' : 'openapi-ts', providerFixture, providerOptions);
}

const SAMPLE = `ts-openapi:
  docs:
    - output: generated/api.json
      info: { title: Test API, version: "1" }
      sources: [src/app.controller.ts]
    - output: generated/other.yaml
      suffixes: [.api.ts, .route.mts]
      info: { title: Other, version: "1" }
`;

test('a docs job declares one exclusive output file, scans its root, reads the program and wants the model boundary', (t: TestContext) => {
  // protects: page "What a job declares" and "Packages": the doc job's facts; a source list is an input, a job without one watches root/src
  const { root, config } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, SAMPLE);
  const [first, second] = loadConfig(config).jobs.filter(job => job.block === 'ts-openapi');
  assert.deepEqual([first?.package, first?.block], ['@exprtlabs/golem-ts-openapi', 'ts-openapi']);
  assert.deepEqual(first?.facts, {
    id: 'docs:generated/api.json',
    outputs: [{ path: path.join(root, 'generated/api.json'), kind: 'file' }],
    ownedRoots: [],
    scanRoots: [root],
    inputFiles: [path.join(root, 'src/app.controller.ts')],
    inputFolders: [],
    readsProgram: true,
    provides: [],
    needs: [],
    wants: ['ModelBoundary'],
    hooks: [],
    watch: [],
  });
  assert.deepEqual(second?.facts.watch, [{ folder: path.join(root, 'src'), suffixes: ['.api.ts', '.route.mts'] }]);
  assert.equal((first?.options as { openapiVersion: string }).openapiVersion, '3.2.0');
});

test('a docs job receives the boundary of the job that provides ModelBoundary as its models option', (t: TestContext) => {
  // protects: page "Contracts": the second pass hands a job the value of a contract it needs (the old `models` option of a controllers job)
  const { root, config } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, docs('api.json'), 'boundary:\n  root: .\n  output: gen/models\n  suffixes: [.entity.ts]\n');
  const job = loadConfig(config).jobs.find(candidate => candidate.block === 'ts-openapi');
  assert.deepEqual((job?.options as { models?: unknown }).models, { root, directory: root, output: path.join(root, 'gen/models'), suffixes: ['.entity.ts'] });
});

test('a docs-only project loads and its docs job gets no models option', (t: TestContext) => {
  // protects: T-768 the doc job wants ModelBoundary and does not need it: no model block, no `models` option (master's optional models)
  const { root, config } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, docs('api.json'), '');
  const options = loadConfig(config).jobs[0]?.options as object;
  assert.equal('models' in options, false);
});

test('a docs job whose source is its own output stops loading as a cycle', (t: TestContext) => {
  // protects: master "Generated input dependency cycle": a job that reads its own document
  const { root, config } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, docs('api.yaml', '      sources: [api.yaml]\n'));
  assert.throws(() => loadConfig(config), /Jobs read each other's output in a cycle: docs:api\.yaml writes what docs:api\.yaml reads\./);
});

test('controller context validates URI versioning and preserves document tags', (t: TestContext) => {
  // protects: the controllers option parse moved into the ts-openapi plan entry (T-768): tags and uriVersioning reach the job options
  const { root, config } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, docs('generated/api.json', `      tags:
        - name: health
          description: Health endpoints
      uriVersioning:
        type: URI
        prefix: v
        defaultVersion: ["1", "2"]
`));
  const options = loadConfig(config).jobs.find(job => job.block === 'ts-openapi')?.options as { tags: unknown; uriVersioning: unknown };
  assert.deepEqual(options.tags, [{ name: 'health', description: 'Health endpoints' }]);
  assert.deepEqual(options.uriVersioning, { type: 'URI', prefix: 'v', defaultVersion: ['1', '2'] });
});

test('docs suffixes are read per job, and a job without them leaves the default to the generator', (t: TestContext) => {
  // protects: old config.test "suffixes are read per job, and a job without them has none"
  const { root, config } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, SAMPLE);
  const [first, second] = loadConfig(config).jobs.filter(job => job.block === 'ts-openapi');
  assert.equal('suffixes' in (first?.options as object), false);
  assert.deepEqual((second?.options as { suffixes: unknown }).suffixes, ['.api.ts', '.route.mts']);
});

test('a docs suffix that is empty, malformed, repeated or names a generated file is a configuration error', (t: TestContext) => {
  // protects: old config.test "a suffix that is empty, malformed, repeated or names a generated file is a configuration error" (controller rows)
  const { root, config } = fixture(t);
  useDocsPackage(root);
  const label = 'ts-openapi.docs[0].suffixes';
  const form = (entry: string): string => `${label}[${entry}] must be a string that starts with "." and ends in .ts, .mts or .cts.`;
  const testCases: [string, string][] = [
    ['[]', `${label} must be a nonempty array.`],
    ['.api.ts', `${label} must be a nonempty array.`],
    ['[api.ts]', form('0')],
    ['[.api.ts, 3]', form('1')],
    ['[.api.js]', form('0')],
    ['[.d.ts]', `${label}[0] must not end in .d.ts, .d.mts or .d.cts: a declaration file cannot be a source.`],
    ['[.api.generated.mts]', `${label}[0] must not end in .generated.ts, .generated.mts or .generated.cts: golem writes those files.`],
    ['[.api.ts, .api.ts]', `${label} lists .api.ts twice.`],
  ];
  for (const [suffixes, message] of testCases) {
    writeConfig(config, docs('api.json', `      suffixes: ${suffixes}\n`));
    assert.throws(() => loadConfig(config), (error: unknown) => error instanceof Error && error.message === message, message);
  }
});

test('a docs root must lie inside the directory of the yaml tsconfig, and the job reads the tsconfig the yaml names', (t: TestContext) => {
  // protects: F-42 one golem.yaml serves one tsconfig (old config.test, controllers layout); T-480 every job reads the tsconfig of golem.yaml
  const { root, config } = fixture(t);
  useDocsPackage(root);
  for (const directory of ['app', 'other']) fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, 'app/tsconfig.json'), '{}');
  writeConfig(config, `tsconfig: app/tsconfig.json\n${docs('api.json').replace('- output:', '- root: other\n      output:')}`);
  assert.throws(() => loadConfig(config), new RegExp(`Job docs:api\\.json: root ${path.relative(process.cwd(), path.join(root, 'other'))} is outside ${path.relative(process.cwd(), path.join(root, 'app'))}; use one golem.yaml per tsconfig\\.`));

  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'tsconfig.app.json'), '{}');
  writeConfig(config, `tsconfig: ./tsconfig.app.json\n${docs('api.json')}`);
  assert.equal((loadConfig(config).jobs.find(job => job.block === 'ts-openapi')?.options as { tsconfig: string }).tsconfig, path.join(root, 'tsconfig.app.json'));
});

test('controller maxResultBytes from golem.yaml reaches the job options and must be a positive integer', (t: TestContext) => {
  // protects: T-376 golem.yaml sets the route result limit; the job options, and so the job hash, carry it
  const { config, root } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, docs('api.json', '      maxResultBytes: 2097152\n'));
  assert.equal((loadConfig(config).jobs.find(job => job.block === 'ts-openapi')?.options as { maxResultBytes: number }).maxResultBytes, 2097152);
  writeConfig(config, docs('api.json', '      maxResultBytes: 0\n'));
  assert.throws(() => loadConfig(config), /ts-openapi\.docs\[0\]\.maxResultBytes must be a positive safe integer/);
});

test('the ts-openapi block takes a nonempty docs list of known keys, and a docs job keeps the framework nestjs', (t: TestContext) => {
  // protects: the block shape of page "golem.yaml" (docs list); old "controller framework accepts NestJS and rejects unsupported adapters" (T-768 keeps framework and root until plan D)
  const { root, config } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, docs('api.json', '      framework: nestjs\n'));
  assert.equal(loadConfig(config).jobs.some(job => job.block === 'ts-openapi'), true);
  const refused: [string, RegExp][] = [
    [docs('api.json', '      framework: express\n'), /ts-openapi\.docs\[0\]\.framework must be nestjs/],
    [docs('api.json', '      retiredOption: true\n'), /Unknown ts-openapi\.docs\[0\] key: retiredOption\./],
    ['ts-openapi:\n  docs: []\n', /ts-openapi\.docs must be a nonempty array of jobs/],
    ['ts-openapi:\n  jobs: []\n', /Unknown ts-openapi key: jobs\./],
  ];
  for (const [body, error] of refused) {
    writeConfig(config, body);
    assert.throws(() => loadConfig(config), error);
  }
});

test('controller output extensions and collisions fail before providers run', (t: TestContext) => {
  const { config, root } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, docs('api.txt'));
  assert.throws(() => loadConfig(config), /JSON or YAML/);
  writeConfig(config, `${docs('api.yaml')}${docs('api.yaml').replace('ts-openapi:\n  docs:\n', '')}`);
  assert.throws(() => loadConfig(config), /Job id docs:api\.yaml is declared twice/);
});

test('controller error diagnostics block exact-file writes while warnings remain typed in the result', async (t: TestContext) => {
  const failing = fixture(t);
  writeConfig(failing.config, docs('generated/api.json'));
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
  assert.equal(fs.existsSync(path.join(failing.root, '.golem/outputs.json')) && 'generated/api.json' in (JSON.parse(fs.readFileSync(path.join(failing.root, '.golem/outputs.json'), 'utf8')) as { files: object }).files, false);

  const warning = fixture(t);
  writeConfig(warning.config, docs('generated/api.json'));
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
  const result = state.results.get('docs:generated/api.json');
  assert.deepEqual(result?.diagnostics, [{ severity: 'warning', code: 'TSOA2001', message: 'custom rule omitted' }]);
  const inventory = JSON.parse(fs.readFileSync(path.join(warning.root, '.golem/outputs.json'), 'utf8')) as {
    files: Record<string, { owner: string; job: string; digest: string; destination: string }>;
  };
  const { digest: recordedDigest, ...recordedEntry } = inventory.files['generated/api.json'] ?? {};
  assert.deepEqual(recordedEntry, {
    owner: '@exprtlabs/golem-ts-openapi',
    job: 'docs:generated/api.json',
    destination: 'generated/api.json',
    destinationKind: 'file',
  });
  assert.equal(recordedDigest, digest('/* Generated by @exprtlabs/golem-ts-openapi. Do not edit. */\n{}\n'));
});

test('controller OpenAPI files stay standards-valid while ownership and retirement remain guarded', (t: TestContext) => {
  const { root } = fixture(t);
  const output = path.join(root, 'generated/api.json');
  const job: GolemJob = jobWithFacts('docs:generated/api.json', '@exprtlabs/golem-ts-openapi', { outputs: [{ path: output, kind: 'file' }] });
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

test('pipeline executes controller output before the SDK consumes its exact file', async (t: TestContext) => {
  const { root, config } = fixture(t);
  const controllerOutput = path.join(root, 'generated/api.json');
  const sdkOutput = path.join(root, 'sdk');
  writeConfig(config, [
    'ts-openapi:',
    '  docs:',
    '    - output: generated/api.json',
    '      info: {title: Test API, version: "1"}',
    'openapi-ts:',
    '  sdks:',
    '    - input: generated/api.json',
    '      output: sdk',
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
});


test('a docs job owns exactly its document: a sibling or descendant file under its root is refused', async t => {
  const { root, config } = fixture(t);
  useDocsPackage(root);
  writeConfig(config, docs('api/openapi.json'));
  const resolved = loadConfig(config);
  const directory = path.dirname(resolved.inventoryFile);
  fs.mkdirSync(directory, { recursive: true });
  for (const key of ['api/notes.json', 'api/openapi.json/child.json']) {
    fs.writeFileSync(resolved.inventoryFile, JSON.stringify({ version: 1, files: {
      [key]: { job: 'docs:api/openapi.json', owner: '@exprtlabs/golem-ts-openapi', digest: '0'.repeat(64), destination: 'api/openapi.json', destinationKind: 'file' },
    } }));
    assert.throws(() => loadInventory(resolved), /exact file destination/);
  }
  const job = resolved.jobs.find(candidate => candidate.block === 'ts-openapi') as GolemJob;
  for (const written of ['api/notes.json', 'api/openapi.json/child.json']) {
    assert.throws(() => applyJob(resolved, { version: 1, files: {} }, job, [{
      path: path.join(root, written),
      content: '{"x-generator":"@exprtlabs/golem-ts-openapi"}',
    }]), /escapes the docs:api\/openapi\.json destination/, written);
  }
});

test('source invalidation regenerates its controller consumers and SDKs without rerunning unrelated controller jobs', async t => {
  const { root, config } = fixture(t);
  for (const name of ['one', 'two', 'shared']) {
    fs.writeFileSync(path.join(root, `src/${name}.ts`), sourceInvalidationModule({ value: name }).text);
  }
  writeConfig(config, `ts-openapi:
  docs:
    - sources: [src/one.ts]
      output: api/one.json
      info: { title: One, version: '1' }
    - sources: [src/two.ts]
      output: api/two.json
      info: { title: Two, version: '1' }
openapi-ts:
  sdks:
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
  // The SDK jobs read no program, so each runs before the program reader that does not read its document (page "Registration", rule 2): Two,SDK-two,One,SDK-one.
  assert.equal(fs.readFileSync(log, 'utf8'), 'Two,SDK-two,One,SDK-one,');
  fs.writeFileSync(log, '');
  await runPipeline(config, { previous: next, changedInputs: [path.join(root, 'api/one.json')] });
  assert.equal(fs.readFileSync(log, 'utf8'), 'SDK-one,');
});
