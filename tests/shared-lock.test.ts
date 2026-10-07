// The lock of a shared model folder: one live process at a time writes the shared companions there.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyJob, loadInventory } from '#golem/outputs';
import type { GolemConfig, GolemJob } from '#golem/config';
import { SharedFolderLocks } from '#golem/shared-lock';

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
