import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '#golem/config';
import { inputDigest, jobIsCurrent, loadJobRecords, saveJobRecords, type JobRecord } from '#golem/job-cache';
import { GOLEM_VERSION } from '#golem/version';
import { createFixtureProject } from './fixture-project.js';

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
    options: JSON.stringify(job.options),
    inputs: {
      'api.yaml': inputDigest(path.join(root, 'api.yaml'), () => false),
      src: inputDigest(path.join(root, 'src'), () => false),
      'absent.json': 'missing',
    },
    outputs: ['sdk.ts'],
    manifests: [],
  };
  return { root, record, config, current: () => jobIsCurrent(config, job, record, new Set()) };
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
  assert.equal(jobIsCurrent(config, job, undefined, new Set()), false);
  assert.equal(jobIsCurrent(config, job, { ...record, golem: '0.0.0' }, new Set()), false, 'another golem version');
  assert.equal(jobIsCurrent(config, job, { ...record, options: '{}' }, new Set()), false, 'other options');
  assert.equal(jobIsCurrent(config, job, { ...record, outputs: ['sdk.ts', 'gone.ts'] }, new Set()), false, 'an output is gone');
  assert.equal(jobIsCurrent(config, job, record, new Set()), true);
  fs.appendFileSync(path.join(root, 'api.yaml'), '\n');
  assert.equal(jobIsCurrent(config, job, record, new Set()), false, 'an edited file');
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

test('a generated file is left out of a directory listing', (t: TestContext) => {
  const { root, config, record } = project(t);
  const job = config.jobs[0];
  assert.ok(job);
  const generated = path.join(root, 'src/a.model.generated.ts');
  fs.writeFileSync(generated, 'export {};\n');
  assert.equal(jobIsCurrent(config, job, record, new Set()), false);
  assert.equal(jobIsCurrent(config, job, record, new Set([generated])), true);
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
  assert.equal(jobIsCurrent(config, job, { ...record, inputs: {} }, new Set()), false);
});
