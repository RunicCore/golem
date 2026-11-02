// The input scan and watcher: what a watching loop compares with after a run, which paths it reports as changed, and the events that start a tick.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { changedPaths, InputScan, InputWatcher, realInputFiles, RunBaseline } from '#golem/input-watcher';
import type { InputFiles } from '#golem/input-watcher';
import { countingInputFiles, editUntil, quietly, until } from './support/watch-wait.js';

/** A root with `src/a.model.ts`, and a folder beside it that stands for a shared folder outside the root. */
function projectFolders(t: TestContext): { root: string; shared: string } {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-scan-')));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const root = path.join(outer, 'app');
  const shared = path.join(outer, 'shared');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(root, 'src/a.model.ts'), 'export type TA = 1;\n');
  fs.writeFileSync(path.join(shared, 'money.model.ts'), 'export type TMoney = 1;\n');
  return { root, shared };
}

test('a model file created while a run is in flight is reported by the next scan, as an input and as a name in its folder', (t) => {
  // protects: T-307 a source that appears during a run gets its current state as the baseline and is never seen
  const { root } = projectFolders(t);
  const known = path.join(root, 'src/a.model.ts');
  const added = path.join(root, 'src/b.model.ts');
  const elsewhere = path.join(path.dirname(root), 'elsewhere.model.ts');
  const scope = { root };
  const before = new InputScan([known], scope, realInputFiles).snapshot();
  const baseline = new RunBaseline(before, root, realInputFiles);
  baseline.observe(known);
  // The folder of an input outside the root is recorded when the run first reads it.
  baseline.observeFolder(path.dirname(root));
  // The run has read what it read; the file appears after that.
  fs.writeFileSync(added, 'export type TB = 1;\n');
  // A file outside every scanned folder is seen only as an input.
  fs.writeFileSync(elsewhere, 'export type TE = 1;\n');
  const after = new InputScan([known, added, elsewhere], scope, realInputFiles).snapshot();

  const previous = baseline.settle(after);
  assert.deepEqual(changedPaths(previous, after).sort(), [added, elsewhere].sort());
  const folderOnly = new InputScan([known], scope, realInputFiles).snapshot();
  assert.deepEqual(changedPaths(baseline.settle(folderOnly), folderOnly), [added], 'the names in the folder report it when it is no input yet');
});

test('an input the run read first takes the state it had then, and a file the run wrote takes its state now', (t) => {
  // protects: T-307 the baseline order: before the run, else at the first read, else missing
  const { root } = projectFolders(t);
  const known = path.join(root, 'src/a.model.ts');
  const read = path.join(root, 'src/read.ts');
  const written = path.join(root, 'src/a.model.generated.ts');
  const scope = { root };
  fs.writeFileSync(read, '1');
  const before = new InputScan([known], scope, realInputFiles).snapshot();
  const baseline = new RunBaseline(before, root, realInputFiles);
  baseline.observe(read);
  fs.writeFileSync(read, '22');
  fs.writeFileSync(written, 'generated');
  const after = new InputScan([known, read, written], scope, realInputFiles).snapshot();

  const previous = baseline.settle(after, (file) => file === written);
  assert.deepEqual(changedPaths(previous, after, (file) => file === written), [read], 'the edit after the first read is a change; the generated file is not');
});

test('a name added to a scanned folder outside the root is reported, and a name the loop wrote is not', (t) => {
  // protects: T-308 a source added to a shared folder outside the root is a change
  const { root, shared } = projectFolders(t);
  const outside = path.join(shared, 'money.model.ts');
  const scope = { root };
  const scan = new InputScan([outside], scope, realInputFiles);
  const previous = scan.snapshot();
  fs.writeFileSync(path.join(shared, 'order.model.ts'), 'export type TOrder = 1;\n');
  fs.writeFileSync(path.join(shared, 'order.model.generated.ts'), 'generated');

  const owns = (file: string): boolean => file === path.join(shared, 'order.model.generated.ts');
  assert.deepEqual(changedPaths(previous, scan.snapshot(), owns), [path.join(shared, 'order.model.ts')]);
  fs.rmSync(outside);
  assert.deepEqual(changedPaths(previous, scan.snapshot(), owns).sort(), [outside, path.join(shared, 'order.model.ts')].sort(), 'a removed name is reported too');
});

test('editor temporary files and hidden files are not reported', (t) => {
  // protects: T-307 editor temp files must not start a run
  const { root } = projectFolders(t);
  const scope = { root };
  const scan = new InputScan([path.join(root, 'src/a.model.ts')], scope, realInputFiles);
  const previous = scan.snapshot();
  fs.writeFileSync(path.join(root, 'src/a.model.ts~'), 'backup');
  fs.writeFileSync(path.join(root, 'src/.#a.model.ts'), 'lock');
  fs.writeFileSync(path.join(root, 'src/.a.model.ts.swp'), 'swap');
  assert.deepEqual(changedPaths(previous, scan.snapshot()), []);
});

test('a folder created below a descent root is scanned, so a source added to it later is reported', (t) => {
  // protects: T-29 a source in a folder that held no input is found
  const { root } = projectFolders(t);
  const scope = { root, descend: [root] };
  const scan = new InputScan([path.join(root, 'src/a.model.ts')], scope, realInputFiles);
  fs.mkdirSync(path.join(root, 'lib'));
  const previous = scan.snapshot();
  fs.writeFileSync(path.join(root, 'lib/pet.model.ts'), 'export type TPet = 1;\n');
  assert.deepEqual(changedPaths(previous, scan.snapshot()), [path.join(root, 'lib/pet.model.ts')]);
});

test('a hidden folder that an input lies in is scanned, and a folder under node_modules is not', (t) => {
  // protects: T-308 a tsconfig that includes .vitepress/**/*.ts still sees a new file there
  const { root } = projectFolders(t);
  const config = path.join(root, '.vitepress/config.ts');
  const dependency = path.join(root, 'node_modules/pkg/index.ts');
  fs.mkdirSync(path.dirname(config));
  fs.mkdirSync(path.dirname(dependency), { recursive: true });
  fs.writeFileSync(config, 'export default {};\n');
  fs.writeFileSync(dependency, 'export {};\n');
  const scan = new InputScan([config, dependency], { root }, realInputFiles);
  const previous = scan.snapshot();
  fs.writeFileSync(path.join(root, '.vitepress/theme.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'node_modules/pkg/other.ts'), 'export {};\n');
  assert.deepEqual(changedPaths(previous, scan.snapshot()), [path.join(root, '.vitepress/theme.ts')]);
});

test('an installed package is no scanned input, and a file linked from outside node_modules is', (t) => {
  // protects: R-31 node_modules is not scanned, except a linked workspace package (T-208)
  const { root, shared } = projectFolders(t);
  const installed = path.join(root, 'node_modules/pkg/index.ts');
  const hoisted = path.join(root, 'node_modules/.pnpm/store/index.ts');
  const linked = path.join(root, 'node_modules/@acme/shared/money.model.ts');
  const missing = path.join(root, 'node_modules/probe/index.ts');
  for (const file of [installed, hoisted]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export {};\n');
  }
  fs.mkdirSync(path.dirname(path.dirname(linked)), { recursive: true });
  fs.symlinkSync(shared, path.dirname(linked), 'dir');
  fs.symlinkSync(path.join(root, 'node_modules/.pnpm/store'), path.join(root, 'node_modules/alias'), 'dir');

  const scan = new InputScan([path.join(root, 'src/a.model.ts'), installed, linked, missing, path.join(root, 'node_modules/alias/index.ts')], { root }, realInputFiles);

  assert.deepEqual([...scan.files], [path.join(root, 'src/a.model.ts'), linked]);
  assert.deepEqual([...scan.linkedFolders], [shared], 'a change to the linked file happens in its real folder');
});

/** A watcher over `folders` that records the `installed` flag of each tick, the errors it reports and each time it finds nothing to watch. */
function ticking(t: TestContext, root: string, folders: readonly string[], files?: Pick<InputFiles, 'watch'>): { ticks: boolean[]; errors: Error[]; unwatchable: boolean[]; watcher: InputWatcher } {
  const ticks: boolean[] = [];
  const errors: Error[] = [];
  const unwatchable: boolean[] = [];
  const watcher = new InputWatcher({ root: () => root, tick: async (installed) => { ticks.push(installed); }, onError: (error) => { errors.push(error); }, onUnwatchable: () => { unwatchable.push(true); }, files });
  t.after(() => watcher.close());
  watcher.sync(folders);
  return { ticks, errors, unwatchable, watcher };
}

const FILE_EVENTS: readonly (readonly [string, (folder: string) => void])[] = [
  ['a file is created', (folder) => fs.writeFileSync(path.join(folder, 'new.model.ts'), 'export {};\n')],
  ['a file is edited', (folder) => fs.writeFileSync(path.join(folder, 'a.model.ts'), 'export type TA = 2;\n')],
];
for (const [name, act] of FILE_EVENTS) {
  test(`a tick starts when ${name}`, async (t) => {
    // protects: R-31 a created or edited file wakes the watch
    const { root } = projectFolders(t);
    const folder = path.join(root, 'src');
    const { ticks } = ticking(t, root, [folder]);
    await editUntil(() => act(folder), () => ticks.length > 0, name);
    assert.equal(ticks[0], false);
  });
}

test('a hidden file and an editor temporary file start no tick', async (t) => {
  // protects: R-31 a hidden file or a name that ends in ~ is no input
  const { root } = projectFolders(t);
  const folder = path.join(root, 'src');
  const { ticks } = ticking(t, root, [folder]);
  // FSEvents (macOS) reports the files created just before the watch opened; that tick is settled first.
  await quietly();
  const settled = ticks.length;
  fs.writeFileSync(path.join(folder, '.a.model.ts.swp'), 'swap');
  fs.writeFileSync(path.join(folder, 'a.model.ts~'), 'backup');
  await quietly();
  assert.equal(ticks.length, settled, 'nothing started a tick');
  fs.writeFileSync(path.join(folder, 'b.model.ts'), 'export {};\n');
  await until(() => ticks.length > 0, 'the control: a source file starts a tick');
});

test('an install marker starts a tick that says so, and another write in node_modules starts none', async (t) => {
  // protects: R-31 a package manager's install is told by its marker; installed files are not watched
  const { root } = projectFolders(t);
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(modules, 'pkg'), { recursive: true });
  const { ticks } = ticking(t, root, []);
  fs.writeFileSync(path.join(modules, 'pkg/index.js'), 'export {};\n');
  fs.writeFileSync(path.join(modules, 'other.json'), '{}');
  await quietly();
  assert.deepEqual(ticks, [], 'a write inside node_modules started no tick');
  fs.writeFileSync(path.join(modules, '.package-lock.json'), '{}');
  await until(() => ticks.length > 0, 'the install marker');
  assert.deepEqual(ticks, [true]);
});

test('an event with no file name in the node_modules folder starts a tick that says an install happened', async (t) => {
  // protects: fixed bug, a null name in a marker folder (reported by some platforms for an install) lost the rerun
  const { root } = projectFolders(t);
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(modules);
  const listeners = new Map<string, (event: string, name: string | null) => void>();
  const files: Pick<InputFiles, 'watch'> = {
    watch: (folder, listener) => {
      listeners.set(folder, listener);
      return realInputFiles.watch(folder, listener);
    },
  };
  const { ticks } = ticking(t, root, [], files);
  await quietly();
  listeners.get(modules)?.('rename', null);
  await until(() => ticks.length > 0, 'the nameless event');
  assert.deepEqual(ticks, [true]);
});

test('an event during a tick starts exactly one more tick after it, and events in one burst start one', async (t) => {
  // protects: R-31 ticks never overlap and an edit made during a run is seen after it
  const { root } = projectFolders(t);
  const folder = path.join(root, 'src');
  let running = 0;
  let overlap = false;
  const ticks: number[] = [];
  let release = (): void => {};
  const watcher = new InputWatcher({
    root: () => root,
    tick: async () => {
      running += 1;
      overlap ||= running > 1;
      ticks.push(ticks.length);
      if (ticks.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      running -= 1;
    },
    onError: (error) => { throw error; },
    onUnwatchable: () => { throw new Error('watchable folders'); },
  });
  t.after(() => watcher.close());
  watcher.sync([folder]);
  await editUntil(() => {
    fs.writeFileSync(path.join(folder, 'a.model.ts'), '1');
    fs.writeFileSync(path.join(folder, 'a.model.ts'), '2');
  }, () => ticks.length === 1, 'the first tick, held open');
  fs.writeFileSync(path.join(folder, 'b.model.ts'), '3');
  fs.writeFileSync(path.join(folder, 'c.model.ts'), '4');
  await quietly();
  assert.equal(ticks.length, 1, 'the events during the tick wait for it');
  release();
  await until(() => ticks.length === 2, 'the tick after the held one');
  await quietly();
  assert.equal(ticks.length, 2, 'one tick for the events of the burst');
  assert.equal(overlap, false);
});

test('a folder deleted and created again is watched again', async (t) => {
  // protects: R-31 a watcher on a deleted folder is dead; the next sync opens a new one
  const { root } = projectFolders(t);
  const folder = path.join(root, 'src');
  const { ticks, watcher } = ticking(t, root, [folder]);
  await editUntil(() => {
    fs.rmSync(folder, { recursive: true });
    fs.mkdirSync(folder);
  }, () => ticks.length > 0, 'the events of the delete and the create');
  // inotify (Linux) kills the watcher of a deleted folder, so this sync opens a new one; FSEvents (macOS) watches the path and keeps its watcher.
  watcher.sync([folder]);
  await quietly();
  const seen = ticks.length;
  fs.writeFileSync(path.join(folder, 'again.model.ts'), 'export {};\n');
  await until(() => ticks.length > seen, 'a file created in the new folder');
});

test('a folder that cannot be watched is reported once with its fix, and the watch goes on', async (t) => {
  // protects: R-31 a watch that cannot open is an external failure: loud, once, no exit
  const { root, shared } = projectFolders(t);
  const watchers: fs.FSWatcher[] = [];
  const files: Pick<InputFiles, 'watch'> = {
    watch: (folder, listener) => {
      if (folder === shared) throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
      const watcher = realInputFiles.watch(folder, listener);
      watchers.push(watcher);
      return watcher;
    },
  };
  const { errors, watcher, ticks } = ticking(t, root, [shared, path.join(root, 'src')], files);
  watcher.sync([shared, path.join(root, 'src')]);
  assert.equal(errors.length, 1, 'reported once though it was tried twice');
  assert.match(errors[0].message, /^golem cannot watch .*shared \(ENOSPC\)/);
  assert.match(errors[0].message, /fs\.inotify\.max_user_watches/);

  watchers[0].emit('error', Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }));
  assert.equal(errors.length, 3);
  assert.match(errors[1].message, /\(EMFILE\)[^]*open-file limit/);
  assert.match(errors[2].message, /cannot watch any source folder/, 'the last working watcher failed');
  assert.equal(ticks.length, 0);
});

test('closing the watcher closes every folder watch', (t) => {
  // protects: R-31 every watcher closes when the loop stops
  const { root } = projectFolders(t);
  const watchers = countingInputFiles();
  const { watcher } = ticking(t, root, [path.join(root, 'src'), root], watchers.files);
  assert.equal(watchers.openWatches(), 2, 'the two folders are watched');
  watcher.close();
  assert.equal(watchers.openWatches(), 0);
});

test('no folder can be watched: the watcher says so once and tells the loop to end', (t) => {
  // protects: R-31 a loop with no working watcher ends and fails instead of sleeping for ever
  const { root } = projectFolders(t);
  const files: Pick<InputFiles, 'watch'> = { watch: () => { throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' }); } };
  const { errors, unwatchable, watcher } = ticking(t, root, [path.join(root, 'src')], files);
  watcher.sync([path.join(root, 'src')]);
  assert.deepEqual(unwatchable, [true]);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /fs\.inotify\.max_user_watches/);
  assert.equal(errors[1].message, 'golem cannot watch any source folder, so it stops.');
});

test('a watch that opened only the node_modules marker folders ends when every source folder failed', (t) => {
  // protects: T-490 an install-marker watch is no source watch: counting it left the loop asleep for ever
  const { root } = projectFolders(t);
  fs.mkdirSync(path.join(root, 'node_modules'));
  const files: Pick<InputFiles, 'watch'> = {
    watch: (folder, listener) => {
      if (path.basename(folder) !== 'node_modules') throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
      return realInputFiles.watch(folder, listener);
    },
  };
  const { errors, unwatchable } = ticking(t, root, [path.join(root, 'src')], files);
  assert.deepEqual(unwatchable, [true]);
  assert.equal(errors[errors.length - 1]!.message, 'golem cannot watch any source folder, so it stops.');
});

test('a watcher that errors because its folder is gone is dropped without a report, and the folder is looked at again', async (t) => {
  // protects: R-31 Windows reports a deleted folder as a watcher error
  const { root } = projectFolders(t);
  const folder = path.join(root, 'src');
  const watchers: fs.FSWatcher[] = [];
  const files: Pick<InputFiles, 'watch'> = {
    watch: (target, listener) => {
      const watcher = realInputFiles.watch(target, listener);
      watchers.push(watcher);
      return watcher;
    },
  };
  const { errors, unwatchable, ticks, watcher } = ticking(t, root, [folder], files);
  fs.rmSync(folder, { recursive: true });
  watchers[0].emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }));
  await until(() => ticks.length > 0, 'the tick that looks at the folder again');
  assert.deepEqual([errors, unwatchable], [[], []]);
  fs.mkdirSync(folder);
  assert.equal(watcher.sync([folder]), true, 'the folder is watched again once it is back');
});

test('an event for an input with a hidden name starts a tick, and another hidden name does not', async (t) => {
  // protects: R-31 a tsconfig that extends ./.tsconfig.base.json is an input like any other
  const { root } = projectFolders(t);
  const base = path.join(root, '.tsconfig.base.json');
  fs.writeFileSync(base, '{}');
  const scan = new InputScan([base], { root }, realInputFiles);
  const { ticks, watcher } = ticking(t, root, []);
  watcher.snapshotWatching(scan);
  // FSEvents (macOS) reports the creation of the input that happened just before the watch opened; that tick is settled first.
  await quietly();
  const settled = ticks.length;
  fs.writeFileSync(path.join(root, '.other.json'), '{}');
  await quietly();
  assert.equal(ticks.length, settled, 'a hidden name that is no input starts nothing');
  fs.writeFileSync(base, '{"compilerOptions":{}}');
  await until(() => ticks.length > 0, 'the hidden input');
});

test('the folder of every input outside the root is scanned, a missing one included, but not a folder that holds the root', (t) => {
  // protects: R-31 an extended base config, an imported sibling file or a missing import outside the root is watched
  const { root, shared } = projectFolders(t);
  const outer = path.dirname(root);
  const base = path.join(outer, 'tsconfig.base.json');
  fs.writeFileSync(base, '{}');
  const missingInShared = path.join(shared, 'later.ts');
  const missingAbove = path.join(outer, 'package.json');
  const scan = new InputScan([path.join(root, 'src/a.model.ts'), base, missingInShared, missingAbove, path.join(outer, 'absent/new.ts')], { root }, realInputFiles);
  const folders = scan.snapshot().folders;
  assert.deepEqual([...folders.keys()].filter((folder) => !isInside(root, folder)).sort(), [outer, shared].sort());
  assert.deepEqual(folders.get(shared), ['money.model.ts']);
  const created = scan.snapshot();
  fs.writeFileSync(missingInShared, 'export {};\n');
  assert.deepEqual(changedPaths(created, scan.snapshot()), [missingInShared]);
});

function isInside(directory: string, filename: string): boolean {
  return filename === directory || filename.startsWith(`${directory}${path.sep}`);
}
