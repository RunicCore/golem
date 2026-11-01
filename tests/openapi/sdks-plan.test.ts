import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import type { OpenApiOptions } from '#openapi/plan';
import { copyFixtureFile } from '../fixture-project.js';
import { workspaceLinkedProject } from '../support/consumer.js';
import { loadConfig } from '../support/load-config.js';

/** An app that lists golem-openapi-ts and golem-model, with a document `api.yaml`, and `yaml` as its golem.yaml. */
function project(t: TestContext, yaml: string): { root: string; filename: string } {
  const root = workspaceLinkedProject(t, 'golem-openapi-ts-block-', JSON.stringify({
    name: 'app', type: 'module', dependencies: { '@exprtlabs/golem-openapi-ts': '1.0.0', '@exprtlabs/golem-model': '1.0.0' },
  }));
  fs.writeFileSync(path.join(root, 'api.yaml'), 'openapi: 3.1.0');
  const filename = path.join(root, 'golem.yaml');
  fs.writeFileSync(filename, yaml);
  return { root, filename };
}

const SDK = 'openapi-ts:\n  sdks:\n    - input: api.yaml\n      output: sdk\n';

test('an SDK job declares its document as the input and one output folder, and its paths are anchored to golem.yaml', async (t: TestContext) => {
  // protects: T-769 page "What a job declares": an SDK job reads its document and owns one exclusive folder; a standalone SDK needs no contract
  const { root, filename } = project(t, `version: 1\n${SDK}`);
  const [job, ...others] = (await loadConfig(filename)).jobs;
  assert.deepEqual(others, []);
  assert.ok(job);
  assert.equal(job.id, 'openapi:sdk');
  assert.equal(job.package, '@exprtlabs/golem-openapi-ts');
  assert.equal(job.block, 'openapi-ts');
  assert.deepEqual(job.facts, {
    id: 'openapi:sdk',
    outputs: [{ path: path.join(root, 'sdk'), kind: 'folder' }],
    ownedRoots: [], inputFiles: [path.join(root, 'api.yaml')], inputFolders: [],
    readsProgram: false, provides: [], needs: [], hooks: ['client.operationWrapper'], watch: [],
  });
  assert.deepEqual(job.options as OpenApiOptions, {
    input: path.join(root, 'api.yaml'), output: path.join(root, 'sdk'),
    profile: { mobx: false, validation: true, allowAny: false, unknownFormats: 'error' },
    allowRemoteRefs: false, remoteHosts: [], mode: 'standalone',
    maxRefBytes: 5 * 1024 * 1024, maxRefDocuments: 256, refTimeoutMs: 10000,
  });
});

test('the SDK options mode, name, dates, remoteHosts and the reference limits reach the generator options', async (t: TestContext) => {
  // protects: T-695 mode and its default; remoteHosts, maxRefBytes and the other reference limits stay options of the SDK job
  const { filename } = project(t, [
    'version: 1', 'openapi-ts:', '  sdks:', '    - input: api.yaml', '      output: sdk', '      name: Payments', '      dates: temporal',
    '      allowRemoteRefs: true', '      remoteHosts: [schemas.example]', '      maxRefBytes: 1024', '      maxRefDocuments: 4', '      refTimeoutMs: 500', '',
  ].join('\n'));
  const [job] = (await loadConfig(filename)).jobs;
  assert.ok(job);
  const { name, dates, allowRemoteRefs, remoteHosts, maxRefBytes, maxRefDocuments, refTimeoutMs } = job.options as OpenApiOptions;
  assert.deepEqual({ name, dates, allowRemoteRefs, remoteHosts, maxRefBytes, maxRefDocuments, refTimeoutMs },
    { name: 'Payments', dates: 'temporal', allowRemoteRefs: true, remoteHosts: ['schemas.example'], maxRefBytes: 1024, maxRefDocuments: 4, refTimeoutMs: 500 });
});

test('a golem-mode SDK needs the codecs host, takes its codecs file from it and runs before the model job that writes that file', async (t: TestContext) => {
  // protects: T-769 page "Packages": a golem SDK needs CodecsHost; the model job reads the SDK folder, so the SDK job runs first
  const { root, filename } = project(t, `version: 1\n${SDK}      mode: golem\nmodel:\n  output: models\n`);
  const config = await loadConfig(filename);
  assert.deepEqual(config.jobs.map(job => job.id), ['openapi:sdk', 'model']);
  const [sdk, model] = config.jobs;
  assert.ok(sdk && model);
  assert.deepEqual(sdk.facts.needs, ['CodecsHost']);
  assert.equal((sdk.options as OpenApiOptions).mode, 'golem');
  assert.equal((sdk.options as OpenApiOptions).codecsFile, path.join(root, 'models', 'sdk.sdk.generated.ts'));
  assert.deepEqual(Reflect.get(model.options as object, 'sdkOutputs'), [path.join(root, 'sdk')]);
});

test('a golem-mode SDK without a model block stops loading and names the job and the contract', async (t: TestContext) => {
  // protects: T-695 mode golem needs the model job (page: a needed contract with no provider stops loading)
  const { filename } = project(t, `version: 1\n${SDK}      mode: golem\n`);
  await assert.rejects(() => loadConfig(filename), /Job openapi:sdk needs the contract CodecsHost, but no job provides it/);
});

test('the openapi-ts block refuses an unknown key, a wrong value and an empty list, each with the key it names', async (t: TestContext) => {
  // protects: T-769 the option checks of the old openapi section stay with the SDK jobs, under the key sdks
  const refused: [string, RegExp][] = [
    ['openapi-ts:\n  jobs: []\n', /Unknown openapi-ts key: jobs\./],
    ['openapi-ts:\n  sdks: []\n', /openapi-ts\.sdks must be a nonempty array of jobs\./],
    [`${SDK}      retiredOption: true\n`, /Unknown openapi-ts\.sdks\[0\] key: retiredOption\./],
    [`${SDK}      mode: hybrid\n`, /openapi-ts\.sdks\[0\]\.mode must be "standalone" or "golem"/],
    [`${SDK}      mode: 1\n`, /openapi-ts\.sdks\[0\]\.mode must be "standalone" or "golem"/],
    [`${SDK}      dates: iso\n`, /openapi-ts\.sdks\[0\]\.dates must be "date" or "temporal"/],
    [`${SDK}      allowRemoteRefs: true\n`, /openapi-ts\.sdks\[0\]\.allowRemoteRefs requires remoteHosts/],
    [`${SDK}      remoteHosts: schemas.example\n`, /openapi-ts\.sdks\[0\]\.remoteHosts must be an array/],
    [`${SDK}      maxRefBytes: 0\n`, /openapi-ts\.sdks\[0\]\.maxRefBytes must be a positive safe integer/],
    ['openapi-ts:\n  sdks:\n    - output: sdk\n', /openapi-ts\.sdks\[0\]\.input must be a nonempty string/],
  ];
  for (const [block, error] of refused) await assert.rejects(() => loadConfig(project(t, `version: 1\n${block}`).filename), error, block);
});

test('SDK outputs that overlap stop loading, also through a link to a folder', async (t: TestContext) => {
  // protects: T-769 page "Overlap": exclusive outputs never overlap, and a folder link resolves before the check
  const nested = project(t, 'version: 1\nopenapi-ts:\n  sdks:\n    - { input: api.yaml, output: sdk }\n    - { input: api.yaml, output: sdk/nested }\n');
  await assert.rejects(() => loadConfig(nested.filename), /Overlapping outputs/);

  const alias = project(t, 'version: 1\nopenapi-ts:\n  sdks:\n    - { input: api.yaml, output: sdk }\n    - { input: api.yaml, output: alias/nested }\n');
  fs.mkdirSync(path.join(alias.root, 'sdk'));
  fs.symlinkSync(path.join(alias.root, 'sdk'), path.join(alias.root, 'alias'), 'dir');
  await assert.rejects(() => loadConfig(alias.filename), /Overlapping outputs/);
});

test('a standalone SDK job with mobx: true shows the generator error, not a manifest error', async (t: TestContext) => {
  // protects: T-735 golem generate prints a generator's error diagnostics before it checks the result for a manifest
  const { root, filename } = project(t, 'version: 1\nmobx: true\nopenapi-ts:\n  sdks:\n    - input: api.json\n      output: sdk\n      name: Profile\n');
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');

  await assert.rejects(() => runPipeline(filename), /OPENAPI_MOBX_NEEDS_GOLEM_MODE/);
});
