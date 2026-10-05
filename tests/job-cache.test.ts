import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '#golem/config';
import { inputDigest, insideAny, jobIsCurrent, loadJobRecords, saveJobRecords, type JobRecord, type JobSetup } from '#golem/job-cache';
import { GOLEM_VERSION } from '#golem/version';
import { createFixtureProject } from './fixture-project.js';

const SETUP: JobSetup = { provider: '1.0.0', manifestInputs: [] };

/** A project with one OpenAPI job whose record the tests build by hand. */
function project(t: TestContext): { root: string; record: JobRecord; current: () => boolean; config: ReturnType<typeof loadConfig> } {
  const root = createFixtureProject(t, 'golem-job-cache-');
  fs.writeFileSync(path.join(root, 'api.yaml'), 'openapi: 3.1.0');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.model.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'sdk.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nopenapi:\n  - input: api.yaml\n    output: sdk\n');
  const config = loadConfig(path.join(root, 'golem.yaml'));
  const job = config.jobs[0];
  assert.ok(job);
  const record: JobRecord = {
    golem: GOLEM_VERSION,
    provider: SETUP.provider ?? '',
    options: JSON.stringify(job.options),
    inputs: {
      'api.yaml': inputDigest(path.join(root, 'api.yaml'), () => false, root),
      src: inputDigest(path.join(root, 'src'), () => false, root),
      'absent.json': 'missing',
    },
    manifestInputs: [],
    outputs: ['sdk.ts'],
    manifests: [],
  };
  return { root, record, config, current: () => jobIsCurrent(config, job, record, SETUP, new Set()) };
}

test('records survive a save and load, and an absent or unreadable file holds none', (t: TestContext) => {
  const { root, record, config } = project(t);
  assert.equal(loadJobRecords(config).size, 0);
  saveJobRecords(config, new Map([['openapi:sdk', record]]));
  assert.deepEqual([...loadJobRecords(config)], [['openapi:sdk', record]]);
  fs.writeFileSync(path.join(root, '.golem/jobs.json'), '{"version":');
  assert.equal(loadJobRecords(config).size, 0);
  fs.writeFileSync(path.join(root, '.golem/jobs.json'), JSON.stringify({ version: 1, jobs: { 'openapi:sdk': { golem: 1 } } }));
  assert.equal(loadJobRecords(config).size, 0, 'a record of the wrong shape is no record');
});

test('a job is current while its version, options, outputs and every input are as its record holds them', (t: TestContext) => {
  const { root, config, record } = project(t);
  const job = config.jobs[0];
  assert.ok(job);
  assert.equal(jobIsCurrent(config, job, undefined, SETUP, new Set()), false);
  assert.equal(jobIsCurrent(config, job, { ...record, golem: '0.0.0' }, SETUP, new Set()), false, 'another golem version');
  assert.equal(jobIsCurrent(config, job, { ...record, options: '{}' }, SETUP, new Set()), false, 'other options');
  assert.equal(jobIsCurrent(config, job, { ...record, outputs: ['sdk.ts', 'gone.ts'] }, SETUP, new Set()), false, 'an output is gone');
  assert.equal(jobIsCurrent(config, job, record, SETUP, new Set()), true);
  fs.appendFileSync(path.join(root, 'api.yaml'), '\n');
  assert.equal(jobIsCurrent(config, job, record, SETUP, new Set()), false, 'an edited file');
});

test('a directory input changes with the files it lists, not with generated files or dot-directories', (t: TestContext) => {
  const { root, current } = project(t);
  assert.equal(current(), true);
  fs.mkdirSync(path.join(root, 'src/.cache'));
  fs.writeFileSync(path.join(root, 'src/.cache/x.ts'), '');
  assert.equal(current(), true, 'a dot-directory is not listed');
  fs.writeFileSync(path.join(root, 'src/b.model.ts'), 'export {};\n');
  assert.equal(current(), false, 'a new model file changes the listing');
});

test('a directory outside the golem.yaml directory is recorded by existence, one inside it by its listing', (t: TestContext) => {
  const { root, config } = project(t);
  const job = config.jobs[0];
  assert.ok(job);
  const outside = fs.mkdtempSync(path.join(path.dirname(root), 'golem-job-cache-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'one.ts'), 'export {};\n');
  const inputs = { 'api.yaml': inputDigest(path.join(root, 'api.yaml'), () => false, root) };
  const recorded = {
    golem: GOLEM_VERSION,
    provider: SETUP.provider ?? '',
    options: JSON.stringify(job.options),
    inputs: { ...inputs, [path.relative(root, outside)]: inputDigest(outside, () => false, root), src: inputDigest(path.join(root, 'src'), () => false, root) },
    manifestInputs: [],
    outputs: ['sdk.ts'],
    manifests: [],
  } satisfies JobRecord;
  const current = (): boolean => jobIsCurrent(config, job, recorded, SETUP, new Set());
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

test('a directory listing leaves out the ignored directories', (t: TestContext) => {
  const { root, config, record } = project(t);
  const job = config.jobs[0];
  assert.ok(job);
  const ignored = [path.join(root, 'build'), path.join(root, 'types')];
  const recorded = { ...record, outputs: [], inputs: { '': inputDigest(root, (filename) => insideAny(ignored, filename), root) } };
  const current = (): boolean => jobIsCurrent(config, job, recorded, SETUP, new Set(), ignored);
  assert.equal(current(), true);
  fs.mkdirSync(path.join(root, 'build/nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/nested/a.js'), '');
  fs.mkdirSync(path.join(root, 'types'));
  fs.writeFileSync(path.join(root, 'types/a.d.ts'), '');
  assert.equal(current(), true, 'compiler output is no input');
  fs.writeFileSync(path.join(root, 'b.ts'), '');
  assert.equal(current(), false, 'a new file outside the ignored directories changes the listing');
});

test('a generated file is left out of a directory listing', (t: TestContext) => {
  const { root, config, record } = project(t);
  const job = config.jobs[0];
  assert.ok(job);
  const generated = path.join(root, 'src/a.model.generated.ts');
  fs.writeFileSync(generated, 'export {};\n');
  assert.equal(jobIsCurrent(config, job, record, SETUP, new Set()), false);
  assert.equal(jobIsCurrent(config, job, record, SETUP, new Set([generated])), true);
});

test('an input recorded as missing makes the job stale once it exists', (t: TestContext) => {
  const { root, current } = project(t);
  assert.equal(current(), true);
  fs.writeFileSync(path.join(root, 'absent.json'), '{}');
  assert.equal(current(), false);
});

test('a job that recorded no input is never current', (t: TestContext) => {
  const { config, record } = project(t);
  const job = config.jobs[0];
  assert.ok(job);
  assert.equal(jobIsCurrent(config, job, { ...record, inputs: {} }, SETUP, new Set()), false);
});

test('a job is stale when its provider version or the manifests it receives are not those of its record', (t: TestContext) => {
  const { root, config, record } = project(t);
  const job = config.jobs[0];
  assert.ok(job);
  const manifest = path.join(root, 'sdk/model-manifest.json');
  assert.equal(jobIsCurrent(config, job, record, SETUP, new Set()), true);
  assert.equal(jobIsCurrent(config, job, record, { ...SETUP, provider: '1.1.0' }, new Set()), false, 'another provider version');
  assert.equal(jobIsCurrent(config, job, record, { ...SETUP, provider: undefined }, new Set()), false, 'a provider that cannot be resolved');
  assert.equal(jobIsCurrent(config, job, record, { ...SETUP, manifestInputs: [manifest] }, new Set()), false, 'a manifest the record did not receive');
  const received = { ...record, manifestInputs: ['sdk/model-manifest.json'] };
  assert.equal(jobIsCurrent(config, job, received, { ...SETUP, manifestInputs: [manifest] }, new Set()), true);
  assert.equal(jobIsCurrent(config, job, received, SETUP, new Set()), false, 'a manifest the job no longer receives');
});
