// The input poller: what a watching loop compares with after a run, and which paths it reports as changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { changedPaths, InputPoller, RunBaseline } from '#golem/input-poller';

/** A root with `src/a.model.ts`, and a folder beside it that stands for a shared folder outside the root. */
function projectFolders(t: TestContext): { root: string; shared: string } {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'golem-poller-')));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const root = path.join(outer, 'app');
  const shared = path.join(outer, 'shared');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(root, 'src/a.model.ts'), 'export type TA = 1;\n');
  fs.writeFileSync(path.join(shared, 'money.model.ts'), 'export type TMoney = 1;\n');
  return { root, shared };
}

test('a model file created while a run is in flight is reported by the next poll, as an input and as a name in its folder', (t) => {
  // protects: T-307 a source that appears during a run gets its current state as the baseline and is never seen
  const { root } = projectFolders(t);
  const known = path.join(root, 'src/a.model.ts');
  const added = path.join(root, 'src/b.model.ts');
  const elsewhere = path.join(path.dirname(root), 'elsewhere.model.ts');
  const scope = { root, outsideDirectories: new Set<string>() };
  const before = new InputPoller([known], scope).snapshot();
  const baseline = new RunBaseline(before, root);
  baseline.observe(known);
  // The run has read what it read; the file appears after that.
  fs.writeFileSync(added, 'export type TB = 1;\n');
  // A file outside every polled folder is seen only as an input.
  fs.writeFileSync(elsewhere, 'export type TE = 1;\n');
  const after = new InputPoller([known, added, elsewhere], scope).snapshot();

  const previous = baseline.settle(after);
  assert.deepEqual(changedPaths(previous, after).sort(), [added, elsewhere].sort());
  const folderOnly = new InputPoller([known], scope).snapshot();
  assert.deepEqual(changedPaths(baseline.settle(folderOnly), folderOnly), [added], 'the names in the folder report it when it is no input yet');
});

test('an input the run read first takes the state it had then, and a file the run wrote takes its state now', (t) => {
  // protects: T-307 the baseline order: before the run, else at the first read, else missing
  const { root } = projectFolders(t);
  const known = path.join(root, 'src/a.model.ts');
  const read = path.join(root, 'src/read.ts');
  const written = path.join(root, 'src/a.model.generated.ts');
  const scope = { root, outsideDirectories: new Set<string>() };
  fs.writeFileSync(read, '1');
  const before = new InputPoller([known], scope).snapshot();
  const baseline = new RunBaseline(before, root);
  baseline.observe(read);
  fs.writeFileSync(read, '22');
  fs.writeFileSync(written, 'generated');
  const after = new InputPoller([known, read, written], scope).snapshot();

  const previous = baseline.settle(after, (file) => file === written);
  assert.deepEqual(changedPaths(previous, after, (file) => file === written), [read], 'the edit after the first read is a change; the generated file is not');
});

test('a name added to a polled folder outside the root is reported, and a name the loop wrote is not', (t) => {
  // protects: T-308 a source added to a shared folder outside the root is a change
  const { root, shared } = projectFolders(t);
  const outside = path.join(shared, 'money.model.ts');
  const scope = { root, outsideDirectories: new Set([shared]) };
  const poller = new InputPoller([outside], scope);
  const previous = poller.snapshot();
  fs.writeFileSync(path.join(shared, 'order.model.ts'), 'export type TOrder = 1;\n');
  fs.writeFileSync(path.join(shared, 'order.model.generated.ts'), 'generated');

  const owns = (file: string): boolean => file === path.join(shared, 'order.model.generated.ts');
  assert.deepEqual(changedPaths(previous, poller.snapshot(), owns), [path.join(shared, 'order.model.ts')]);
  fs.rmSync(outside);
  assert.deepEqual(changedPaths(previous, poller.snapshot(), owns).sort(), [outside, path.join(shared, 'order.model.ts')].sort(), 'a removed name is reported too');
});

test('editor temporary files and hidden files are not reported', (t) => {
  // protects: T-307 editor temp files must not start a run
  const { root } = projectFolders(t);
  const scope = { root, outsideDirectories: new Set<string>() };
  const poller = new InputPoller([path.join(root, 'src/a.model.ts')], scope);
  const previous = poller.snapshot();
  fs.writeFileSync(path.join(root, 'src/a.model.ts~'), 'backup');
  fs.writeFileSync(path.join(root, 'src/.#a.model.ts'), 'lock');
  fs.writeFileSync(path.join(root, 'src/.a.model.ts.swp'), 'swap');
  assert.deepEqual(changedPaths(previous, poller.snapshot()), []);
});

test('a folder created below a descent root is polled, so a source added to it later is reported', (t) => {
  // protects: T-29 a source in a folder that held no input is found
  const { root } = projectFolders(t);
  const scope = { root, outsideDirectories: new Set<string>(), descend: [root] };
  const poller = new InputPoller([path.join(root, 'src/a.model.ts')], scope);
  fs.mkdirSync(path.join(root, 'lib'));
  const previous = poller.snapshot();
  fs.writeFileSync(path.join(root, 'lib/pet.model.ts'), 'export type TPet = 1;\n');
  assert.deepEqual(changedPaths(previous, poller.snapshot()), [path.join(root, 'lib/pet.model.ts')]);
});
