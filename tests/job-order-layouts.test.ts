import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from '#golem/config';
import { runPipeline } from '#golem/cli';
import type { ProgramView } from '#golem/job-facts';
import { copyFixture, createFixtureProject } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { workspace } from './support/process.js';

const DOCS = `ts-openapi:
  docs:
    - output: api/payments.yaml
      info: { title: Payments, version: "1" }
`;
const MODEL = 'model: {}\n';

function sdks(output: string, mode: 'golem' | 'standalone'): string {
  return `openapi-ts:\n  sdks:\n    - input: api/payments.yaml\n      output: ${output}\n      mode: ${mode}\n`;
}

/** The third-party generator of tests/fixtures/job-order/acme. */
function acme(options: Readonly<Record<string, string | boolean>>): string {
  return `acme:\n${Object.entries(options).map(([key, value]) => `  ${key}: ${String(value)}\n`).join('')}`;
}

const DOC_JOB = 'docs:api/payments.yaml';
const DOC_FILE = 'api/payments.yaml';

/** An app folder with golem's three packages and the third-party generator installed, and the golem.yaml of `blocks` in it; returns the app folder. */
function app(t: TestContext, blocks: string): string {
  const root = createFixtureProject(t, 'golem-job-order-');
  const folder = path.join(root, 'app');
  const golemPackages = ['golem', 'golem-model', 'golem-ts-openapi', 'golem-openapi-ts'];
  fs.mkdirSync(path.join(folder, 'node_modules/@exprtlabs'), { recursive: true });
  for (const name of golemPackages) fs.symlinkSync(path.join(workspace, 'packages', name), path.join(folder, `node_modules/@exprtlabs/${name}`), 'dir');
  copyFixture(path.join(folder, 'node_modules/@fixture/acme-generator'), 'job-order/acme');
  const dependencies = Object.fromEntries([...golemPackages.map((name) => `@exprtlabs/${name}`), '@fixture/acme-generator'].map((name) => [name, '*']));
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'job-order-app', dependencies }));
  fs.writeFileSync(path.join(folder, 'golem.yaml'), `version: 1\n${blocks}`);
  return folder;
}

interface Layout {
  readonly name: string;
  /** The page review rounds whose finding the row keeps fixed. */
  readonly protects: string;
  readonly blocks: string;
  readonly jobs: readonly string[];
  /** The program views by job id; the later outputs are paths below the app folder. */
  readonly views: Readonly<Record<string, { laterOutputs: readonly string[] }>>;
}

const LAYOUTS: readonly Layout[] = [
  {
    name: 'a standalone SDK outside the tsconfig folder',
    protects: 'round 1: the docs, SDK, models, docs cycle; an SDK outside the app is left out of the doc job program',
    blocks: DOCS + sdks('../sibling/sdk', 'standalone') + MODEL,
    jobs: [DOC_JOB, 'openapi:../sibling/sdk', 'model'],
    views: { [DOC_JOB]: { laterOutputs: ['../sibling/sdk'] }, model: { laterOutputs: [] } },
  },
  {
    name: 'a generator outside the app',
    protects: 'round 3: a generator that no job reads runs first and its output never reaches a program',
    blocks: DOCS + MODEL + acme({ output: '../elsewhere/gen' }),
    jobs: ['acme', DOC_JOB, 'model'],
    views: { [DOC_JOB]: { laterOutputs: [] }, model: { laterOutputs: [] } },
  },
  {
    name: 'a generator listed after the doc block',
    protects: 'round 3: the doc job needs no list position to run after a generator whose files the app imports',
    blocks: DOCS + acme({ output: 'src/generated/acme' }) + MODEL,
    jobs: ['acme', DOC_JOB, 'model'],
    views: { [DOC_JOB]: { laterOutputs: [] }, model: { laterOutputs: [] } },
  },
  {
    name: 'a generator that the models job reads',
    protects: 'round 2: file edges alone missed the models job reading an earlier generator (a job that needs the codecs host)',
    blocks: MODEL + DOCS + acme({ output: 'src/generated/acme', needsCodecs: true }),
    jobs: ['acme', 'model', DOC_JOB],
    views: { model: { laterOutputs: [DOC_FILE] }, [DOC_JOB]: { laterOutputs: [] } },
  },
  {
    name: 'a generator that reads the document',
    protects: 'round 4: only the models provider is stubbed; the later generator output is left out of the doc program',
    blocks: DOCS + MODEL + acme({ output: 'src/generated/acme', input: DOC_FILE }),
    jobs: [DOC_JOB, 'acme', 'model'],
    views: { [DOC_JOB]: { laterOutputs: ['src/generated/acme'] }, model: { laterOutputs: [] } },
  },
  {
    name: 'no doc job',
    protects: 'round 4: a project without a doc job still orders the golem SDK before the models job',
    blocks: MODEL + sdks('sdk', 'golem'),
    jobs: ['openapi:sdk', 'model'],
    views: { model: { laterOutputs: [] } },
  },
  {
    name: 'a controller that imports a companion',
    protects: 'round 3: the doc job runs first and sees the companions of the models job as stubs, so it keeps its controllers',
    blocks: DOCS + MODEL,
    jobs: [DOC_JOB, 'model'],
    views: { [DOC_JOB]: { laterOutputs: [] }, model: { laterOutputs: [] } },
  },
  {
    name: 'a controller that imports a companion, models block listed first',
    protects: 'round 4: two program readers that do not read each other keep the config order',
    blocks: MODEL + DOCS,
    jobs: ['model', DOC_JOB],
    views: { model: { laterOutputs: [DOC_FILE] }, [DOC_JOB]: { laterOutputs: [] } },
  },
  {
    name: 'a golem SDK inside the app between the doc job and the models job',
    protects: 'round 1: the docs, SDK, models, docs cycle',
    blocks: MODEL + sdks('sdk', 'golem') + DOCS,
    jobs: [DOC_JOB, 'openapi:sdk', 'model'],
    views: { [DOC_JOB]: { laterOutputs: ['sdk'] }, model: { laterOutputs: [] } },
  },
];

for (const layout of LAYOUTS) {
  test(`job order: ${layout.name}`, async (t) => {
    // protects: page review rounds 1 to 4: the job order of the reviewed layout, each row names its round
    const folder = app(t, layout.blocks);

    const config = await resolveConfig(path.join(folder, 'golem.yaml'));

    assert.deepEqual(config.jobs.map((job) => job.id), layout.jobs, layout.protects);
    const views: Record<string, ProgramView> = {};
    for (const [id, view] of Object.entries(layout.views)) views[id] = { laterOutputs: view.laterOutputs.map((output) => path.join(folder, output)) };
    assert.deepEqual(config.jobPlan.programViews, views, layout.protects);
  });
}

test('a doc job whose program view changes runs again, with its options and inputs as they were', async (t) => {
  // protects: T-786 the job cache key holds the program view, so a golem SDK added after the doc job does not leave its document stale
  const controller = "import { Controller, Get } from '@nestjs/common';\n@Controller('ping')\nexport class PingController {\n  @Get()\n  ping(): void {}\n}\n";
  const folder = createControllerFixture(t, { prefix: 'golem-view-cache-', packageName: 'view-cache', sourceFile: 'src/ping.controller.ts', source: controller, files: { 'golem.yaml': `version: 1\n${DOCS + MODEL}` } });
  const config = path.join(folder, 'golem.yaml');
  assert.deepEqual([...(await runPipeline(config)).ran], [DOC_JOB, 'model']);
  assert.deepEqual([...(await runPipeline(config)).ran], [], 'nothing changed, so every job is skipped');

  fs.writeFileSync(config, `version: 1\n${DOCS + MODEL + sdks('sdk', 'golem')}`);
  const second = await runPipeline(config);

  assert.equal(second.ran.has(DOC_JOB), true);
});
