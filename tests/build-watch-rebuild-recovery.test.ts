// golem build --watch: one build per edit, an error, and recovery.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { write, serdeProject, USE, snapshot } from './support/build-project.js';
import { golem } from './support/process.js';

/** How long a watching build gets to exit after SIGINT before the test fails with what it printed. */
const STOP_TIMEOUT_MS = 15_000;

interface Watching { readonly pid: number; readonly output: () => string; readonly stop: () => Promise<number | null> }

function watching(t: TestContext, root: string): Watching {
  const child: ChildProcess = spawn(process.execPath, [golem, 'build', '--watch', '-p', 'tsconfig.json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk; });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(() => { child.kill('SIGKILL'); });
  const stop = async (): Promise<number | null> => {
    child.kill('SIGINT');
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`golem build --watch did not exit ${STOP_TIMEOUT_MS} ms after SIGINT. Output:\n${output}`)); }, STOP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([exited, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  assert.ok(child.pid, 'the watching build started');
  return { pid: child.pid, output: () => output, stop };
}

async function until(condition: () => boolean, label: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const count = (output: string, pattern: RegExp): number => output.split('\n').filter((line) => pattern.test(line)).length;
test('golem build --watch rebuilds once per edit, reports an error, recovers, and sees a new file', async (t) => {
  const root = serdeProject(t, 'build-watch');
  write(root, 'src/use.ts', USE);
  const before = snapshot(root);
  const watcher = watching(t, root);
  await until(() => count(watcher.output(), /^Built /) === 1, 'the first build');

  write(root, 'src/use.ts', `${USE}export const second = 2;\n`);
  await until(() => count(watcher.output(), /^Built /) === 2, 'the rebuild after one edit');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(count(watcher.output(), /^Built /), 2, 'one edit triggers one rebuild');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /second = 2/);

  write(root, 'src/use.ts', `${USE}export const broken: number = 'text';\n`);
  await until(() => count(watcher.output(), /^Build failed/) === 1, 'the failed build');
  assert.match(watcher.output(), /src\/use\.ts\(\d+,\d+\): error TS2322/);

  write(root, 'src/use.ts', `${USE}export const third = 3;\n`);
  await until(() => count(watcher.output(), /^Built /) === 3, 'the build after the fix');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /third = 3/);

  // A file created in a directory the build already watches starts a rebuild, though no input changed.
  write(root, 'src/added.ts', 'export const added = 4;\n');
  await until(() => count(watcher.output(), /^Built /) === 4, 'the rebuild after a new file');
  assert.ok(fs.existsSync(path.join(root, 'build/added.js')));

  // Deleting the output starts one rebuild that writes it again; writing it is not a change.
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  await until(() => count(watcher.output(), /^Built /) === 5, 'the rebuild after outDir was deleted');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(count(watcher.output(), /^Built /), 5, 'deleting outDir triggers exactly one rebuild');
  assert.ok(fs.existsSync(path.join(root, 'build/use.js')));
  assert.equal(await watcher.stop(), 130);

  const after = new Map(snapshot(root));
  after.delete('src/added.ts');
  after.delete('src/use.ts');
  const expected = new Map(before);
  expected.delete('src/use.ts');
  assert.deepEqual(after, expected, 'a watching build changes no file it does not own');
});
