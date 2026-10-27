// lane: typescript6 the program that each job opens from the tsconfig golem.yaml names, and the bundler plugin that refuses a solution tsconfig
// Every job reads the tsconfig that golem.yaml names; a tsconfig nearer to a job root is not read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { build as esbuild } from 'esbuild';

import { runPipeline, watchPipeline } from '#golem/cli';
import { golem as esbuildPlugin } from '#golem/esbuild';
import { generate } from '#model/generator';
import { createModelProject } from './model-project.js';
import { build, buildAndListJobs, sourceOnlyProject, USE, write } from './support/build-project.js';
import { workspace } from './support/process.js';
import { runRewritten } from './support/rewritten-module.js';
import { quietly, until, watchStarted } from './support/watch-wait.js';

const OPTIONS = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true };
const SOLUTION = JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] });
const ITEM_MODEL = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Id } from '@lib/ids.js';\nexport type TItem = IModel<{ id: Id }>;\n";
const MODELS_YAML = (root: string): string => `version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: ${root}\n`;

/** A model project with no tsconfig of its own yet: the caller writes every tsconfig. */
function bareProject(t: TestContext, name: string): string {
  const { root } = createModelProject(t, { prefix: 'golem-job-tsconfig-', name, linkTypescript: true, packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') } });
  fs.rmSync(path.join(root, 'tsconfig.json'));
  return root;
}

function json(root: string, relative: string, value: unknown): void {
  write(root, relative, JSON.stringify(value));
}

test('a solution tsconfig.json beside the tsconfig.app.json that golem.yaml names: generate, check and build agree on the codec keys', async (t) => {
  // protects: T-480 a solution tsconfig beside the named tsconfig does not change the codec keys
  const root = sourceOnlyProject(t, 'job-tsconfig-solution-beside');
  fs.renameSync(path.join(root, 'tsconfig.json'), path.join(root, 'tsconfig.app.json'));
  write(root, 'tsconfig.json', SOLUTION);
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: false\ntsconfig: ./tsconfig.app.json\nmodels:\n  root: .\n');
  write(root, 'src/use.ts', USE);
  const yaml = path.join(root, 'golem.yaml');

  await runPipeline(yaml);
  const keys = (JSON.parse(fs.readFileSync(path.join(root, '.golem/codec-keys.json'), 'utf8')) as { keys: Record<string, string> }).keys;
  const id = keys['src/money.model.ts#TMoney'];
  assert.match(id ?? '', /^TMoney_[0-9a-f]{8}$/, 'generate keys the model by its path from the tsconfig directory');
  await runPipeline(yaml, { check: true });
  assert.equal((await build(root)).exitCode, 0);

  const ids = runRewritten(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8')).codecIds;
  assert.deepEqual([...new Set(ids)], [id], 'the build rewrote the calls with the id that generate wrote');
});

test('a golem.yaml that names the solution tsconfig.json is refused by generate, check, build and the esbuild plugin with one message', async (t) => {
  // protects: T-480 every consumer refuses a solution tsconfig with the same message
  const root = sourceOnlyProject(t, 'job-tsconfig-solution-named');
  fs.renameSync(path.join(root, 'tsconfig.json'), path.join(root, 'tsconfig.app.json'));
  write(root, 'tsconfig.json', SOLUTION);
  write(root, 'src/main.ts', 'export const main = 1;\n');
  const yaml = path.join(root, 'golem.yaml');
  // The project was generated while golem.yaml named the app tsconfig; then the yaml names the solution.
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: false\ntsconfig: ./tsconfig.app.json\nmodels:\n  root: .\n');
  await runPipeline(yaml);
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: false\ntsconfig: ./tsconfig.json\nmodels:\n  root: .\n');
  const shown = (name: string): string => path.relative(process.cwd(), path.join(fs.realpathSync(root), name));
  const refusal = `${shown('tsconfig.json')} only lists project references, so it has no files; name the referenced project in tsconfig:. A golem.yaml names one project. Build each project of ${shown('tsconfig.json')} with its own golem.yaml, in dependency order:\n  ${shown('tsconfig.app.json')}: golem build --config ${shown('golem.yaml')}`;
  const refused = (error: Error): boolean => {
    assert.ok(error.message.includes(refusal), error.message);
    assert.doesNotMatch(error.message, /host/i);
    return true;
  };

  await assert.rejects(runPipeline(yaml), refused);
  await assert.rejects(runPipeline(yaml, { check: true }), refused);
  await assert.rejects(build(root), refused);
  await assert.rejects(esbuild({ absWorkingDir: root, entryPoints: ['src/main.ts'], bundle: true, write: false, logLevel: 'silent', plugins: [esbuildPlugin({ config: yaml })] }), refused);
});

/** A parent tsconfig that includes the package `packages/app`, which has its own tsconfig.json holding the only `@lib` alias. */
function parentWithPackageProject(t: TestContext, name: string): { root: string; app: string } {
  const root = bareProject(t, name);
  const app = path.join(root, 'packages/app');
  json(root, 'tsconfig.json', { compilerOptions: OPTIONS, include: ['packages/*/src/**/*.ts'] });
  json(root, 'packages/app/tsconfig.json', { compilerOptions: { ...OPTIONS, paths: { '@lib/*': ['./src/lib/*'] } }, include: ['src/**/*.ts'] });
  write(root, 'packages/app/src/lib/ids.ts', 'export type Id = string;\n');
  write(root, 'packages/app/src/item.model.ts', ITEM_MODEL);
  write(root, 'golem.yaml', MODELS_YAML('packages/app'));
  return { root, app };
}

test('a parent tsconfig that includes a package with its own tsconfig.json is the one the job reads: an alias only in the package is not resolved', async (t) => {
  // protects: T-480 the job reads the tsconfig golem.yaml names, not the package's own
  const { root } = parentWithPackageProject(t, 'job-tsconfig-parent-wins');
  await assert.rejects(runPipeline(path.join(root, 'golem.yaml')), /TS2307: Cannot find module '@lib\/ids\.js'/);
  assert.equal(fs.existsSync(path.join(root, 'packages/app/src/generated/models')), false, 'the failed job wrote no companion');
});

test('a context without tsconfig passed to the model generator opens the nearest tsconfig.json', (t) => {
  // protects: T-480 a caller of the published generator outside golem.yaml keeps the nearest-tsconfig lookup
  const { app } = parentWithPackageProject(t, 'job-tsconfig-nearest');
  const result = generate({ root: app, profile: { mobx: false, validation: false } });
  assert.ok(result.artifacts.some((artifact) => artifact.path.endsWith('item.model.generated.ts')), 'the alias of the nearest tsconfig resolved');
  assert.deepEqual(result.watchInputs.filter((input) => input.endsWith('tsconfig.json')), [path.join(app, 'tsconfig.json')]);
});

test('a run, the same run again, then a change of tsconfig: in golem.yaml: the second run skips the job and the third runs it', async (t) => {
  // protects: T-480 the tsconfig path is part of the job record
  const root = sourceOnlyProject(t, 'job-tsconfig-record');
  write(root, 'src/use.ts', USE);
  write(root, 'tsconfig.build.json', JSON.stringify({ extends: './tsconfig.json' }));

  assert.deepEqual(await buildAndListJobs(root), { exitCode: 0, ran: ['models:.'] });
  assert.deepEqual(await buildAndListJobs(root), { exitCode: 0, ran: [] }, 'nothing changed, so the job is skipped');
  write(root, 'golem.yaml', `${fs.readFileSync(path.join(root, 'golem.yaml'), 'utf8')}tsconfig: ./tsconfig.build.json\n`);
  assert.deepEqual(await buildAndListJobs(root), { exitCode: 0, ran: ['models:.'] }, 'another tsconfig: runs the job again');
});

/** A project whose golem.yaml names tsconfig.app.json, which extends tsconfig.base.json, which holds the `@lib` alias; `pkg/tsconfig.json` is nearer to the job root and has none. */
function watchedProject(t: TestContext): { root: string; yaml: string } {
  const root = bareProject(t, 'job-tsconfig-watch');
  json(root, 'tsconfig.base.json', { compilerOptions: { ...OPTIONS, paths: { '@lib/*': ['./pkg/src/lib/*'] } } });
  json(root, 'tsconfig.app.json', { extends: './tsconfig.base.json', include: ['pkg/src/**/*.ts'] });
  json(root, 'pkg/tsconfig.json', { compilerOptions: OPTIONS, include: ['src/**/*.ts'] });
  write(root, 'pkg/src/lib/ids.ts', 'export type Id = string;\n');
  write(root, 'pkg/src/item.model.ts', ITEM_MODEL);
  write(root, 'golem.yaml', `version: 1\nmobx: false\nvalidation: false\ntsconfig: ./tsconfig.app.json\nmodels:\n  root: pkg\n`);
  return { root, yaml: path.join(root, 'golem.yaml') };
}

/** Starts a watch on `yaml`, waits for its first run, and gives `act` the watch's state; stops the watch after. */
async function watching(yaml: string, act: (watch: { readonly runs: () => number; readonly errors: readonly unknown[] }) => Promise<void>): Promise<void> {
  const lines: string[] = [];
  const errors: unknown[] = [];
  const stop = watchPipeline(yaml, (error) => { errors.push(error); }, { onRun: (line) => { lines.push(line); } });
  try {
    await until(() => lines.length === 1, 'the first run');
    await watchStarted();
    await act({ runs: () => lines.length, errors });
  } finally {
    stop();
  }
}

for (const [name, edited, edit] of [
  ['the tsconfig that golem.yaml names', 'tsconfig.app.json', { extends: './tsconfig.base.json', include: ['pkg/src/**/*.ts'], compilerOptions: { paths: {} } }],
  ['a file that tsconfig extends', 'tsconfig.base.json', { compilerOptions: OPTIONS }],
] as const) {
  test(`in a watch, an edit of ${name} runs the job again`, async (t) => {
    // protects: T-480 the tsconfig and its extends chain are inputs of the job
    const { root, yaml } = watchedProject(t);
    await watching(yaml, async ({ errors }) => {
      assert.deepEqual(errors, []);
      json(root, edited, edit);
      // The edit drops the alias, so the job that runs again reports it: a run that read nothing new would stay quiet.
      await until(() => errors.length === 1, 'the job to run again with the edited tsconfig');
      assert.match((errors[0] as Error).message, /TS2307: Cannot find module '@lib\/ids\.js'/);
    });
  });
}

test('in a watch, an edit of a tsconfig nearer to the job root that golem.yaml does not name runs nothing', async (t) => {
  // protects: T-480 only the tsconfig golem.yaml names is read, so only it is watched
  const { root, yaml } = watchedProject(t);
  await watching(yaml, async ({ runs, errors }) => {
    json(root, 'pkg/tsconfig.json', { compilerOptions: OPTIONS, include: [] });
    await quietly(600);
    assert.equal(runs(), 1, 'no second run');
    assert.deepEqual(errors, []);
    // The watch is alive: an edit of the named tsconfig that drops the alias does run the job.
    json(root, 'tsconfig.base.json', { compilerOptions: OPTIONS });
    await until(() => errors.length === 1, 'the job to run again with the edited tsconfig');
  });
});
