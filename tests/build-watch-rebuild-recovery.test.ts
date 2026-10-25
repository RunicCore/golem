// lane: typescript6 ProgramSession in the `golem build --watch` driver, where users run it
// golem build --watch: one build per edit, an error, and recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runBuild } from '#golem/build';
import { write, serdeProject, USE, snapshot } from './support/build-project.js';
import { quietly, until } from './support/watch-wait.js';

/** Collects what the code under test writes to stdout and stderr, and still lets it through. */
function capturedOutput(t: TestContext): () => string {
  let output = '';
  for (const stream of [process.stdout, process.stderr]) {
    const forward = stream.write.bind(stream);
    t.mock.method(stream, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return (forward as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest);
    });
  }
  return () => output;
}

test('golem build --watch rebuilds once per edit, reports an error, recovers, and sees a new file', async (t) => {
  const root = serdeProject(t, 'build-watch');
  write(root, 'src/use.ts', USE);
  const before = snapshot(root);
  // In this process, so the compiler's report can be read and each finished build is counted through onBuilt.
  const controller = new AbortController();
  t.after(() => controller.abort());
  const printed = capturedOutput(t);
  let builtCount = 0;
  let failedCount = 0;
  const built = (): number => builtCount;
  const failed = (): number => failedCount;
  const finished = runBuild({
    watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal,
    onBuilt: ({ exitCode }) => { if (exitCode === 0) builtCount += 1; else failedCount += 1; },
  });
  await until(() => built() === 1, 'the first build');

  write(root, 'src/use.ts', `${USE}export const second = 2;\n`);
  await until(() => built() === 2, 'the rebuild after one edit');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /second = 2/);

  write(root, 'src/use.ts', `${USE}export const broken: number = 'text';\n`);
  await until(() => failed() === 1, 'the failed build');
  assert.match(printed(), /src\/use\.ts\(\d+,\d+\): error TS2322/);

  write(root, 'src/use.ts', `${USE}export const third = 3;\n`);
  await until(() => built() === 3, 'the build after the fix');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /third = 3/);

  // A file created in a directory the build already watches starts a rebuild, though no input changed.
  write(root, 'src/added.ts', 'export const added = 4;\n');
  await until(() => built() === 4, 'the rebuild after a new file');
  assert.ok(fs.existsSync(path.join(root, 'build/added.js')));

  // A model edit regenerates the companion, and the rebuild that follows reads the regenerated file, not the one it read before.
  write(root, 'src/money.model.ts', fs.readFileSync(path.join(root, 'src/money.model.ts'), 'utf8').replace('note: string', 'note: string; edited: number'));
  await until(() => built() === 5, 'the rebuild after a model edit');
  assert.match(fs.readFileSync(path.join(root, 'src/money.model.generated.ts'), 'utf8'), /\bedited\b/);
  assert.match(fs.readFileSync(path.join(root, 'build/money.model.generated.js'), 'utf8'), /\bedited\b/);

  // Deleting the output starts one rebuild that writes it again; writing it is not a change.
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  await until(() => built() === 6, 'the rebuild after outDir was deleted');
  assert.ok(fs.existsSync(path.join(root, 'build/use.js')));
  // The builds' own writes must start no build: any that would come has come within this time.
  await quietly();
  controller.abort();
  assert.equal((await finished).exitCode, 0);
  assert.equal(built(), 6, 'each edit, the new file and the deleted outDir triggered exactly one rebuild, and the builds\' writes none');
  assert.equal(failed(), 1, 'the failed edit is the only failed build');

  // The edited model, the new files and the files the model edit regenerated are the changes this test made or caused.
  const changed = new Set(['src/added.ts', 'src/use.ts', 'src/money.model.ts', 'src/money.model.generated.ts', 'src/generated/models/models.validators.generated.ts']);
  const withoutChanged = (files: ReadonlyMap<string, string>): Map<string, string> => new Map([...files].filter(([file]) => !changed.has(file)));
  const after = withoutChanged(snapshot(root));
  const expected = withoutChanged(before);
  assert.deepEqual(after, expected, 'a watching build changes no file it does not own');
});

test('golem build --watch with an onBuilt that throws on the first build says it is watching, reports the error and builds an edit made during that build', async (t) => {
  // protects: T-429 a throwing onBuilt must not end the first tick before the watch is announced and asked for its next look
  const root = serdeProject(t, 'build-watch-onbuilt');
  write(root, 'src/use.ts', USE);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const printed = capturedOutput(t);
  const model = path.join(root, 'src/money.model.ts');
  // The outputs exist already, so the watching build creates no folder that a watcher on the root would hear.
  await runBuild({ watch: false, config: path.join(root, 'golem.yaml') });
  let built = 0;
  const finished = runBuild({
    watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal,
    // The generate step has read the model, and no watcher is on its folder yet: only the baseline of the first build tells of this edit.
    onGenerated: () => {
      if (built > 0) return;
      fs.appendFileSync(model, '// edited during the first build\n');
    },
    onBuilt: () => {
      built += 1;
      if (built === 1) throw new Error('the caller failed to print');
    },
  });
  await until(() => built === 2, () => `the edit made during the first build is built (output=${printed()})`);
  assert.match(printed(), /the caller failed to print/);
  assert.match(printed(), /Watching for changes\./);
  controller.abort();
  assert.equal((await finished).exitCode, 0);
});
