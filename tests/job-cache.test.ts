import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './support/load-config.js';
import { golemCode, hookCode, inputDigest, insideAny, jobIsCurrent, loadJobRecords, saveJobRecords, type JobRecord, type JobSetup } from '#golem/job-cache';
import { digest, type Inventory } from '#golem/outputs';
import type { EnabledExtension } from '#golem/rewrite-participant';
import { createFixtureProject, linkGolemPackages } from './fixture-project.js';

const SETUP: JobSetup = { providerCode: 'provider-code-digest', hookCode: 'hook-code-digest', programView: '{"laterOutputs":[]}', manifestInputs: [] };

/** The inventory of a job's files: each as it is on disk now. */
function inventoryOf(root: string, files: readonly string[]): Inventory {
  return {
    version: 1,
    files: Object.fromEntries(files.map(file => [file, {
      job: 'openapi:sdk',
      owner: '@exprtlabs/golem-openapi-ts',
      digest: digest(fs.readFileSync(path.join(root, file), 'utf8')),
      destination: 'sdk',
      destinationKind: 'directory' as const,
    }])),
  };
}

/** A project with one OpenAPI job whose record the tests build by hand. */
async function project(t: TestContext): Promise<{ root: string; record: JobRecord; inventory: Inventory; current: () => boolean; config: Awaited<ReturnType<typeof loadConfig>> }> {
  const root = createFixtureProject(t, 'golem-job-cache-');
  fs.writeFileSync(path.join(root, 'api.yaml'), 'openapi: 3.1.0');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.model.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'sdk.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'job-cache-fixture', private: true, type: 'module' }));
  linkGolemPackages(root, ['golem', 'golem-openapi-ts']);
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nopenapi-ts:\n  sdks:\n    - input: api.yaml\n      output: sdk\n');
  const config = await loadConfig(path.join(root, 'golem.yaml'));
  const job = config.jobs[0];
  assert.ok(job);
  const record: JobRecord = {
    golemCode: golemCode(),
    providerCode: SETUP.providerCode ?? '',
    hookCode: SETUP.hookCode,
    programView: SETUP.programView,
    options: JSON.stringify(job.options),
    inputs: {
      'api.yaml': inputDigest(path.join(root, 'api.yaml'), () => false, root),
      src: inputDigest(path.join(root, 'src'), () => false, root),
      'absent.json': 'missing',
    },
    manifestInputs: [],
    outputs: ['sdk.ts'],
    records: {},
    manifests: [],
    warnings: [],
  };
  const inventory = inventoryOf(root, ['sdk.ts']);
  return { root, record, inventory, config, current: () => jobIsCurrent(config, job, record, SETUP, inventory) };
}

test('records survive a save and load, and an absent or unreadable file holds none', async (t: TestContext) => {
  const { root, record, config } = await project(t);
  assert.equal(loadJobRecords(config).size, 0);
  saveJobRecords(config, new Map([['openapi:sdk', record]]));
  assert.deepEqual([...loadJobRecords(config)], [['openapi:sdk', record]]);
  fs.writeFileSync(path.join(root, '.golem/jobs.json'), '{"version":');
  assert.equal(loadJobRecords(config).size, 0);
  fs.writeFileSync(path.join(root, '.golem/jobs.json'), JSON.stringify({ version: 1, jobs: { 'openapi:sdk': { golemCode: 1 } } }));
  assert.equal(loadJobRecords(config).size, 0, 'a record of the wrong shape is no record');
});

test('a job is current while its golem code, provider code, options, outputs and every input are as its record holds them', async (t: TestContext) => {
  const { root, config, record, inventory } = await project(t);
  const job = config.jobs[0];
  assert.ok(job);
  assert.equal(jobIsCurrent(config, job, undefined, SETUP, inventory), false);
  assert.equal(jobIsCurrent(config, job, { ...record, golemCode: 'other-golem-code-digest' }, SETUP, inventory), false, 'other golem code');
  assert.equal(jobIsCurrent(config, job, { ...record, options: '{}' }, SETUP, inventory), false, 'other options');
  assert.equal(jobIsCurrent(config, job, record, { ...SETUP, hookCode: 'other-hook-code-digest' }, inventory), false, 'other extensions on the job\'s hooks');
  assert.equal(jobIsCurrent(config, job, record, { ...SETUP, programView: '{"laterOutputs":["sdk"]}' }, inventory), false, 'another program view');
  assert.equal(jobIsCurrent(config, job, { ...record, outputs: ['sdk.ts', 'gone.ts'] }, SETUP, inventory), false, 'an output is gone');
  assert.equal(jobIsCurrent(config, job, record, SETUP, inventory), true);
  fs.appendFileSync(path.join(root, 'api.yaml'), '\n');
  assert.equal(jobIsCurrent(config, job, record, SETUP, inventory), false, 'an edited file');
});

test('the hook digest follows the extensions on a job\'s hooks, their options and their code, and not the order of an options object\'s keys', () => {
  // protects: T-781 the cache key holds the digest of every extension on the job's hooks
  const extension = (name: string, options: Record<string, unknown>): EnabledExtension => ({ package: '@fixture/probe', block: 'probe', name, entry: '/entry.mjs', options });
  const codeOf = (code: string) => () => code;
  const note = { hook: 'hooked.note', extension: extension('note', { prefix: '>', width: 2 }) };
  const base = hookCode([note], codeOf('code-1'));

  assert.equal(hookCode([], codeOf('code-1')), '', 'no extension on a hook of the job');
  assert.equal(hookCode([{ ...note, extension: extension('note', { width: 2, prefix: '>' }) }], codeOf('code-1')), base, 'the same options in another key order');
  assert.notEqual(hookCode([{ ...note, extension: extension('note', { prefix: '#', width: 2 }) }], codeOf('code-1')), base, 'other options');
  assert.notEqual(hookCode([note], codeOf('code-2')), base, 'other code');
  assert.notEqual(hookCode([note, { hook: 'hooked.other', extension: extension('other', {}) }], codeOf('code-1')), base, 'one more extension');
});

test('a job is stale when an output is edited or is not in the inventory', async (t: TestContext) => {
  const { root, config, record, inventory } = await project(t);
  const job = config.jobs[0];
  assert.ok(job);
  assert.equal(jobIsCurrent(config, job, record, SETUP, { version: 1, files: {} }), false, 'an output the inventory does not record');
  fs.appendFileSync(path.join(root, 'sdk.ts'), '// edited by hand\n');
  assert.equal(jobIsCurrent(config, job, record, SETUP, inventory), false, 'an output that differs from its recorded digest');
  assert.equal(jobIsCurrent(config, job, record, SETUP, inventoryOf(root, ['sdk.ts'])), true, 'the inventory holds the new content');
});

test('a directory input changes with the files it lists, not with generated files or dot-directories', async (t: TestContext) => {
  const { root, current } = await project(t);
  assert.equal(current(), true);
  fs.mkdirSync(path.join(root, 'src/.cache'));
  fs.writeFileSync(path.join(root, 'src/.cache/x.ts'), '');
  assert.equal(current(), true, 'a dot-directory is not listed');
  fs.writeFileSync(path.join(root, 'src/b.model.ts'), 'export {};\n');
  assert.equal(current(), false, 'a new model file changes the listing');
});

test('a directory outside the golem.yaml directory is recorded by existence, one inside it by its listing', async (t: TestContext) => {
  const { root, config, inventory } = await project(t);
  const job = config.jobs[0];
  assert.ok(job);
  const outside = fs.mkdtempSync(path.join(path.dirname(root), 'golem-job-cache-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'one.ts'), 'export {};\n');
  const inputs = { 'api.yaml': inputDigest(path.join(root, 'api.yaml'), () => false, root) };
  const recorded = {
    golemCode: golemCode(),
    providerCode: SETUP.providerCode ?? '',
    hookCode: SETUP.hookCode,
    programView: SETUP.programView,
    options: JSON.stringify(job.options),
    inputs: { ...inputs, [path.relative(root, outside)]: inputDigest(outside, () => false, root), src: inputDigest(path.join(root, 'src'), () => false, root) },
    manifestInputs: [],
    outputs: ['sdk.ts'],
    records: {},
    manifests: [],
    warnings: [],
  } satisfies JobRecord;
  const current = (): boolean => jobIsCurrent(config, job, recorded, SETUP, inventory);
  assert.equal(current(), true);
  fs.writeFileSync(path.join(outside, 'two.ts'), 'export {};\n');
  assert.equal(current(), true, 'a new file in a directory outside the root does not change the record');
  fs.rmSync(outside, { recursive: true });
  assert.equal(current(), false, 'the outside directory itself is gone');
  fs.mkdirSync(outside);
  assert.equal(current(), true, 'the directory exists again');
  fs.writeFileSync(path.join(root, 'src/b.model.ts'), 'export {};\n');
  assert.equal(current(), false, 'a new file in a directory inside the root changes the listing');
});

test('a directory listing leaves out the ignored directories', async (t: TestContext) => {
  const { root, config, record } = await project(t);
  const job = config.jobs[0];
  assert.ok(job);
  const ignored = [path.join(root, 'build'), path.join(root, 'types')];
  const recorded = { ...record, outputs: [], inputs: { '': inputDigest(root, (filename) => insideAny(ignored, filename), root) } };
  const current = (): boolean => jobIsCurrent(config, job, recorded, SETUP, { version: 1, files: {} }, ignored);
  assert.equal(current(), true);
  fs.mkdirSync(path.join(root, 'build/nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/nested/a.js'), '');
  fs.mkdirSync(path.join(root, 'types'));
  fs.writeFileSync(path.join(root, 'types/a.d.ts'), '');
  assert.equal(current(), true, 'compiler output is no input');
  fs.writeFileSync(path.join(root, 'b.ts'), '');
  assert.equal(current(), false, 'a new file outside the ignored directories changes the listing');
});

test('a generated file is left out of a directory listing', async (t: TestContext) => {
  const { root, config, record, inventory } = await project(t);
  const job = config.jobs[0];
  assert.ok(job);
  fs.writeFileSync(path.join(root, 'src/a.model.generated.ts'), 'export {};\n');
  assert.equal(jobIsCurrent(config, job, record, SETUP, inventory), false);
  assert.equal(jobIsCurrent(config, job, record, SETUP, inventoryOf(root, ['sdk.ts', 'src/a.model.generated.ts'])), true);
});

test('an input recorded as missing makes the job stale once it exists', async (t: TestContext) => {
  const { root, current } = await project(t);
  assert.equal(current(), true);
  fs.writeFileSync(path.join(root, 'absent.json'), '{}');
  assert.equal(current(), false);
});

test('a job that recorded no input is never current', async (t: TestContext) => {
  const { config, record, inventory } = await project(t);
  const job = config.jobs[0];
  assert.ok(job);
  assert.equal(jobIsCurrent(config, job, { ...record, inputs: {} }, SETUP, inventory), false);
});

test('a job is stale when its provider code or the manifests it receives are not those of its record', async (t: TestContext) => {
  const { root, config, record, inventory } = await project(t);
  const job = config.jobs[0];
  assert.ok(job);
  const manifest = path.join(root, 'sdk/model-manifest.json');
  assert.equal(jobIsCurrent(config, job, record, SETUP, inventory), true);
  assert.equal(jobIsCurrent(config, job, record, { ...SETUP, providerCode: 'other-provider-code-digest' }, inventory), false, 'other provider code');
  assert.equal(jobIsCurrent(config, job, record, { ...SETUP, manifestInputs: [manifest] }, inventory), false, 'a manifest the record did not receive');
  const received = { ...record, manifestInputs: ['sdk/model-manifest.json'] };
  assert.equal(jobIsCurrent(config, job, received, { ...SETUP, manifestInputs: [manifest] }, inventory), true);
  assert.equal(jobIsCurrent(config, job, received, SETUP, inventory), false, 'a manifest the job no longer receives');
});
