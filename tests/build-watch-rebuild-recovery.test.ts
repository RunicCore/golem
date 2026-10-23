// golem build --watch: one build per edit, an error, and recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { write, serdeProject, USE, snapshot } from './support/build-project.js';
import { count, watching } from './support/build-watching.js';
import { until } from './support/watch-wait.js';

test('golem build --watch rebuilds once per edit, reports an error, recovers, and sees a new file', async (t) => {
  const root = serdeProject(t, 'build-watch');
  write(root, 'src/use.ts', USE);
  const before = snapshot(root);
  const watcher = watching(t, root);
  await until(() => count(watcher.output(), /^Built /) === 1, 'the first build');

  write(root, 'src/use.ts', `${USE}export const second = 2;\n`);
  await until(() => count(watcher.output(), /^Built /) === 2, 'the rebuild after one edit');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /second = 2/);

  write(root, 'src/use.ts', `${USE}export const broken: number = 'text';\n`);
  await until(() => count(watcher.output(), /^Build failed/) === 1, 'the failed build');
  assert.match(watcher.output(), /src\/use\.ts\(\d+,\d+\): error TS2322/);
  // Builds run one after another: an extra rebuild after the first edit would have finished before this failed build.
  assert.equal(count(watcher.output(), /^Built /), 2, 'one edit triggers one rebuild');

  write(root, 'src/use.ts', `${USE}export const third = 3;\n`);
  await until(() => count(watcher.output(), /^Built /) === 3, 'the build after the fix');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /third = 3/);

  // A file created in a directory the build already watches starts a rebuild, though no input changed.
  write(root, 'src/added.ts', 'export const added = 4;\n');
  await until(() => count(watcher.output(), /^Built /) === 4, 'the rebuild after a new file');
  assert.ok(fs.existsSync(path.join(root, 'build/added.js')));

  // A model edit regenerates the companion, and the rebuild that follows reads the regenerated file, not the one it read before.
  write(root, 'src/money.model.ts', fs.readFileSync(path.join(root, 'src/money.model.ts'), 'utf8').replace('note: string', 'note: string; edited: number'));
  await until(() => count(watcher.output(), /^Built /) === 5, 'the rebuild after a model edit');
  assert.match(fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8'), /\bedited\b/);
  assert.match(fs.readFileSync(path.join(root, 'build/money.model.generated.js'), 'utf8'), /\bedited\b/);
  assert.equal(count(watcher.output(), /^Build failed/), 1, 'the model edit builds without a new failure');

  // Deleting the output starts one rebuild that writes it again; writing it is not a change.
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  await until(() => count(watcher.output(), /^Built /) === 6, 'the rebuild after outDir was deleted');
  assert.ok(fs.existsSync(path.join(root, 'build/use.js')));

  // The sentinel edit starts build 7 only if deleting outDir started exactly one rebuild; a build the output writes caused would come before it.
  write(root, 'src/use.ts', `${USE}export const fourth = 4;\n`);
  await until(() => count(watcher.output(), /^Built /) === 7, 'the rebuild after the sentinel edit');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /fourth = 4/, 'build 7 is the sentinel edit, not a rebuild of the deleted output');
  assert.equal(await watcher.stop(), 130);
  assert.equal(count(watcher.output(), /^Built /), 7, 'deleting outDir triggers exactly one rebuild');

  // The edited model, the new files and the files the model edit regenerated are the changes this test made or caused.
  const changed = new Set(['src/added.ts', 'src/use.ts', 'src/money.model.ts', 'src/money.model.generated.ts', 'src/generated/models/models.validators.generated.ts']);
  const withoutChanged = (files: ReadonlyMap<string, string>): Map<string, string> => new Map([...files].filter(([file]) => !changed.has(file)));
  const after = withoutChanged(snapshot(root));
  const expected = withoutChanged(before);
  assert.deepEqual(after, expected, 'a watching build changes no file it does not own');
});
