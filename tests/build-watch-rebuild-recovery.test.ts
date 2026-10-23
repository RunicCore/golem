// golem build --watch: one build per edit, an error, and recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runBuild } from '#golem/build';
import { write, serdeProject, USE, snapshot } from './support/build-project.js';
import { until } from './support/watch-wait.js';

test('golem build --watch rebuilds once per edit, reports an error, recovers, and sees a new file', async (t) => {
  const root = serdeProject(t, 'build-watch');
  write(root, 'src/use.ts', USE);
  const before = snapshot(root);
  // In this process, so the watcher can report each poll that found nothing to build.
  const controller = new AbortController();
  t.after(() => controller.abort());
  let output = '';
  for (const stream of [process.stdout, process.stderr]) {
    const forward = stream.write.bind(stream);
    t.mock.method(stream, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return (forward as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest);
    });
  }
  // The test runner writes its own events to the same stream, so a golem line is found by its shape, not by the start of a line.
  const built = (): number => output.match(/Built \S+\n/g)?.length ?? 0;
  const failed = (): number => output.match(/Build failed\.\n/g)?.length ?? 0;
  let idle = 0;
  // A poll that found nothing to build has looked at every file since the last build, so a rebuild that build's own writes caused has started by then.
  const settled = async (): Promise<void> => {
    const seen = idle;
    await until(() => idle > seen, 'a poll that found nothing to build');
  };
  const finished = runBuild({ watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal, onIdlePoll: () => { idle += 1; } });
  await until(() => built() === 1, 'the first build');
  await settled();
  assert.equal(built(), 1, 'the first build\'s writes start no rebuild');

  write(root, 'src/use.ts', `${USE}export const second = 2;\n`);
  await until(() => built() === 2, 'the rebuild after one edit');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /second = 2/);
  await settled();
  assert.equal(built(), 2, 'one edit triggers one rebuild');

  write(root, 'src/use.ts', `${USE}export const broken: number = 'text';\n`);
  await until(() => failed() === 1, 'the failed build');
  assert.match(output, /src\/use\.ts\(\d+,\d+\): error TS2322/);
  await settled();
  assert.equal(failed(), 1, 'the failed edit triggers one rebuild');

  write(root, 'src/use.ts', `${USE}export const third = 3;\n`);
  await until(() => built() === 3, 'the build after the fix');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /third = 3/);
  await settled();

  // A file created in a directory the build already watches starts a rebuild, though no input changed.
  write(root, 'src/added.ts', 'export const added = 4;\n');
  await until(() => built() === 4, 'the rebuild after a new file');
  assert.ok(fs.existsSync(path.join(root, 'build/added.js')));
  await settled();

  // A model edit regenerates the companion, and the rebuild that follows reads the regenerated file, not the one it read before.
  write(root, 'src/money.model.ts', fs.readFileSync(path.join(root, 'src/money.model.ts'), 'utf8').replace('note: string', 'note: string; edited: number'));
  await until(() => built() === 5, 'the rebuild after a model edit');
  assert.match(fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8'), /\bedited\b/);
  assert.match(fs.readFileSync(path.join(root, 'build/money.model.generated.js'), 'utf8'), /\bedited\b/);
  await settled();
  assert.equal(failed(), 1, 'the model edit builds without a new failure');

  // Deleting the output starts one rebuild that writes it again; writing it is not a change.
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  await until(() => built() === 6, 'the rebuild after outDir was deleted');
  assert.ok(fs.existsSync(path.join(root, 'build/use.js')));
  await settled();
  controller.abort();
  assert.equal((await finished).exitCode, 0);
  assert.equal(built(), 6, 'deleting outDir triggers exactly one rebuild');

  // The edited model, the new files and the files the model edit regenerated are the changes this test made or caused.
  const changed = new Set(['src/added.ts', 'src/use.ts', 'src/money.model.ts', 'src/money.model.generated.ts', 'src/generated/models/models.validators.generated.ts']);
  const withoutChanged = (files: ReadonlyMap<string, string>): Map<string, string> => new Map([...files].filter(([file]) => !changed.has(file)));
  const after = withoutChanged(snapshot(root));
  const expected = withoutChanged(before);
  assert.deepEqual(after, expected, 'a watching build changes no file it does not own');
});
