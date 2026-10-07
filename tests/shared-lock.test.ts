// The lock of a shared model folder: one live process at a time writes the shared companions there.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipeline } from '#golem/cli';
import { applyJob, loadInventory } from '#golem/outputs';
import type { GolemConfig, GolemJob } from '#golem/config';
import { SharedFolderLocks } from '#golem/shared-lock';
import { workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';

const OWNER_A = { pid: process.pid, config: '/projects/a/golem.yaml' };
const OWNER_B = { pid: process.pid, config: '/projects/b/golem.yaml' };
const OTHER_CONFIG = '/projects/other/golem.yaml';

function folder(t: TestContext): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-shared-lock-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** The id of a process that has run and exited. */
function exitedPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  assert.ok(result.pid, 'the child process started');
  return result.pid;
}

/** A process that runs until the test ends, as another golem process does. */
function liveProcess(t: TestContext): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  assert.ok(child.pid, 'the child process started');
  return child.pid;
}

test('a session does not hold a folder that another live process holds, and holds it again once it has', (t: TestContext) => {
  const shared = folder(t);
  const other = { pid: liveProcess(t), config: OTHER_CONFIG };
  fs.writeFileSync(path.join(shared, '.golem.lock'), JSON.stringify(other));
  using locks = new SharedFolderLocks(OWNER_A, 'process');
  assert.deepEqual(locks.hold(shared), { holder: other });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, '.golem.lock'), 'utf8')), other, 'the lock is the holder\'s');
  const free = folder(t);
  assert.equal(locks.hold(free), 'held');
  assert.equal(locks.hold(free), 'held', 'the holder holds again');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(free, '.golem.lock'), 'utf8')), OWNER_A);
});

test('a lock with the id of this process that this session does not hold is a leftover of an earlier process', (t: TestContext) => {
  const shared = folder(t);
  fs.writeFileSync(path.join(shared, '.golem.lock'), JSON.stringify({ pid: process.pid, config: OTHER_CONFIG }));
  using locks = new SharedFolderLocks(OWNER_A, 'process');
  assert.equal(locks.hold(shared), 'held');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, '.golem.lock'), 'utf8')), OWNER_A);
});

test('a holder that finds its lock taken by another process no longer holds the folder', (t: TestContext) => {
  const shared = folder(t);
  using locks = new SharedFolderLocks(OWNER_A, 'process');
  assert.equal(locks.hold(shared), 'held');
  const other = { pid: liveProcess(t), config: OTHER_CONFIG };
  fs.writeFileSync(path.join(shared, '.golem.lock'), JSON.stringify(other));
  assert.deepEqual(locks.hold(shared), { holder: other });
});

test('a lock file that its creator has not written yet is waited for', async (t: TestContext) => {
  const shared = folder(t);
  const lock = path.join(shared, '.golem.lock');
  fs.writeFileSync(lock, '');
  // Another process fills the file shortly after it created it. This process waits in `hold`, so it cannot fill the file itself.
  const config = '/projects/slow/golem.yaml';
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    setTimeout(() => fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, config: process.argv[2] })), 150);
    setInterval(() => {}, 1000);
  `, lock, config], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  assert.ok(child.pid, 'the child process started');
  using locks = new SharedFolderLocks(OWNER_A, 'process');
  assert.deepEqual(locks.hold(shared), { holder: { pid: child.pid, config } });
});

test('a lock file that stays empty is a lock whose creator ended', (t: TestContext) => {
  const shared = folder(t);
  fs.writeFileSync(path.join(shared, '.golem.lock'), '');
  using locks = new SharedFolderLocks(OWNER_A, 'process');
  assert.equal(locks.hold(shared), 'held');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, '.golem.lock'), 'utf8')), OWNER_A);
});

test('a lock of a process that does not run is free', (t: TestContext) => {
  const shared = folder(t);
  fs.writeFileSync(path.join(shared, '.golem.lock'), JSON.stringify({ pid: exitedPid(), config: '/projects/gone/golem.yaml' }));
  using locks = new SharedFolderLocks(OWNER_A, 'process');
  assert.equal(locks.hold(shared), 'held');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, '.golem.lock'), 'utf8')), OWNER_A);
});

test('a run lock is released at the end of the write step and a process lock on dispose', (t: TestContext) => {
  const runFolder = folder(t);
  const processFolder = folder(t);
  const runLock = path.join(runFolder, '.golem.lock');
  const processLock = path.join(processFolder, '.golem.lock');
  const run = new SharedFolderLocks(OWNER_A, 'run');
  const long = new SharedFolderLocks(OWNER_B, 'process');
  assert.equal(run.hold(runFolder), 'held');
  assert.equal(long.hold(processFolder), 'held');
  assert.ok(fs.existsSync(runLock) && fs.existsSync(processLock));
  run.endRun();
  long.endRun();
  assert.equal(fs.existsSync(runLock), false, 'the write step ended the run lock');
  assert.equal(fs.existsSync(processLock), true, 'the write step leaves a process lock');
  long[Symbol.dispose]();
  assert.equal(fs.existsSync(processLock), false, 'dispose released the process lock');
});

// A project that includes the shared folder `shared`, beside it, which holds a model with a golem companion.
function sharedProject(t: TestContext): { config: string; app: string; shared: string; companion: string; sharedModel: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-shared-lock-project-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'node_modules/@exprtlabs'), { recursive: true });
  for (const name of ['golem', 'golem-model', 'golem-openapi']) {
    fs.symlinkSync(path.join(workspace, 'packages', name), path.join(base, 'node_modules/@exprtlabs', name), 'dir');
  }
  const app = path.join(base, 'app');
  const shared = path.join(base, 'shared');
  fs.mkdirSync(app);
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"shared-lock-app","type":"module"}');
  writeFixture(app, { mobx: false, validation: true });
  fs.writeFileSync(path.join(shared, 'package.json'), '{"name":"shared","private":true,"type":"module"}');
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true },
    include: ['src/**/*.ts', '../shared/**/*.ts'],
  }));
  const sharedModel = path.join(shared, 'money.model.ts');
  fs.writeFileSync(sharedModel, "import type { IModel } from '@exprtlabs/golem/model';\n\nexport type TMoney = IModel<{ id: string }>;\n");
  return { config: path.join(app, 'golem.yaml'), app, shared, companion: path.join(shared, 'money.model.generated.ts'), sharedModel };
}

const editShared = (sharedModel: string): void => {
  fs.writeFileSync(sharedModel, "import type { IModel } from '@exprtlabs/golem/model';\n\nexport type TMoney = IModel<{ id: string; extra: number }>;\n");
};

/** A change to the app's own model, which makes the models job run again and leaves the shared companion as it is. */
const touchApp = (app: string): void => {
  const file = path.join(app, 'src/cart.model.ts');
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}// touched\n`);
};

const modelsJobRan = (state: { readonly ran: ReadonlySet<string> }): boolean => [...state.ran].some(id => id.startsWith('models:'));

test('with no live holder, a one-shot run rewrites a stale shared companion and leaves no lock', async (t: TestContext) => {
  const { config, shared, companion, sharedModel } = sharedProject(t);
  await runPipeline(config);
  assert.doesNotMatch(fs.readFileSync(companion, 'utf8'), /extra/);
  editShared(sharedModel);
  await runPipeline(config);
  assert.match(fs.readFileSync(companion, 'utf8'), /extra/);
  assert.equal(fs.existsSync(path.join(shared, '.golem.lock')), false);
});

test('with a dead process in the lock, a one-shot run takes the lock, writes and leaves none', async (t: TestContext) => {
  const { config, shared, companion, sharedModel } = sharedProject(t);
  await runPipeline(config);
  fs.writeFileSync(path.join(shared, '.golem.lock'), JSON.stringify({ pid: exitedPid(), config: '/projects/gone/golem.yaml' }));
  editShared(sharedModel);
  await runPipeline(config);
  assert.match(fs.readFileSync(companion, 'utf8'), /extra/);
  assert.equal(fs.existsSync(path.join(shared, '.golem.lock')), false);
});

test('a non-holder with equal text passes and writes nothing; with different text it fails with the incompatible error', async (t: TestContext) => {
  const { config, app, shared, companion, sharedModel } = sharedProject(t);
  await runPipeline(config);
  const lock = path.join(shared, '.golem.lock');
  // A live process that is not this run holds the lock.
  const holder = { pid: liveProcess(t), config: OTHER_CONFIG };
  fs.writeFileSync(lock, JSON.stringify(holder));
  const written = fs.readFileSync(companion, 'utf8');
  const writtenAt = fs.statSync(companion).mtimeMs;

  touchApp(app);
  const state = await runPipeline(config);
  assert.equal(modelsJobRan(state), true, 'the models job compared its text');
  assert.equal(fs.readFileSync(companion, 'utf8'), written);
  assert.equal(fs.statSync(companion).mtimeMs, writtenAt, 'the file was not written');
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), holder, 'the lock is the holder\'s');

  editShared(sharedModel);
  await assert.rejects(
    runPipeline(config),
    { message: `${companion} is incompatible with the shared companion that ${OTHER_CONFIG} (process ${holder.pid}) writes. Generate in that project, or stop it. If no golem process runs, delete ${lock}.` },
  );
  assert.equal(fs.readFileSync(companion, 'utf8'), written, 'the file is unchanged');
  assert.equal(fs.statSync(companion).mtimeMs, writtenAt, 'the file was not written');
});

test('a lock held by a live unrelated process names the lock file in the error', async (t: TestContext) => {
  const { config, shared, companion } = sharedProject(t);
  const lock = path.join(shared, '.golem.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: liveProcess(t), config: '/nonexistent/golem.yaml' }));
  await assert.rejects(runPipeline(config), (error: unknown) => error instanceof Error && error.message.endsWith(`delete ${lock}.`) && error.message.startsWith(`${companion} is incompatible with`));
  assert.equal(fs.existsSync(companion), false, 'the non-holder wrote no companion');
});

test('the error names both golem versions when the headers differ', async (t: TestContext) => {
  const { config, app, shared, companion } = sharedProject(t);
  await runPipeline(config);
  const ours = (JSON.parse(fs.readFileSync(path.join(workspace, 'packages/golem-model/package.json'), 'utf8')) as { version: string }).version;
  const text = fs.readFileSync(companion, 'utf8');
  assert.ok(text.startsWith(`/* Generated by @exprtlabs/golem-model ${ours}. Do not edit. */`), 'the header records the version');
  fs.writeFileSync(companion, text.replace(`golem-model ${ours}.`, 'golem-model 0.0.1.'));
  fs.writeFileSync(path.join(shared, '.golem.lock'), JSON.stringify({ pid: liveProcess(t), config: OTHER_CONFIG }));
  touchApp(app);
  await assert.rejects(runPipeline(config), (error: unknown) => error instanceof Error && error.message.includes(` writes: written by golem 0.0.1, this project uses golem ${ours}. Generate in that project`));
});

/** A lock set in which another live process holds each folder, and which writes `afterHold` as that holder when this process asks for `folder`. */
class OtherProcessHolds extends SharedFolderLocks {
  constructor(private readonly onHold: (folder: string) => void) {
    super(OWNER_A, 'run');
  }

  override hold(folder: string): { readonly holder: { readonly pid: number; readonly config: string } } {
    this.onHold(folder);
    return { holder: { pid: process.pid, config: OTHER_CONFIG } };
  }
}

test('a non-holder never writes a shared companion, even when the holder wrote newer text after the comparison', (t: TestContext) => {
  const base = folder(t);
  const app = path.join(base, 'app');
  const text = (version: number): string => `/* Generated by @exprtlabs/golem-model 1.0.0. Do not edit. */\nexport const version = ${version};\n`;
  const companions = ['first', 'second'].map((name) => {
    const directory = path.join(base, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'money.model.ts'), 'export type TMoney = never;\n');
    const companion = path.join(directory, 'money.model.generated.ts');
    fs.writeFileSync(companion, text(1));
    return companion;
  });
  const job: GolemJob = { id: 'models:.', kind: 'models', package: '@exprtlabs/golem-model', options: { root: app, profile: { mobx: false, validation: true } } };
  const config: GolemConfig = {
    directory: app,
    configFile: path.join(app, 'golem.yaml'),
    inventoryFile: path.join(app, '.golem/outputs.json'),
    tsconfig: path.join(app, 'tsconfig.json'),
    tsconfigNamed: false,
    profile: { mobx: false, validation: true },
    jobs: [job],
  };
  // The holder writes newer text into the first companion while this process compares the second.
  using locks = new OtherProcessHolds((held) => {
    if (held === path.dirname(companions[1])) fs.writeFileSync(companions[0], text(2));
  });

  applyJob(config, loadInventory(config), job, companions.map(companion => ({ path: companion, content: text(1) })), false, locks);
  assert.equal(fs.readFileSync(companions[0], 'utf8'), text(2), 'the holder\'s newer text stays');
});
