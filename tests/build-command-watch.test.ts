// golem build --watch: one build per edit, an error, and recovery.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runBuild } from '#golem/build';
import { HEAVY_TEST_TIMEOUT_MS, write, serdeProject, sourceOnlyProject, countingGenerator, USE, snapshot } from './support/build-project.js';
import { golem } from './support/process.js';

/** How long a watching build gets to exit after SIGINT before the test fails with what it printed. */
const STOP_TIMEOUT_MS = 15_000;

// Watch

interface Watching { readonly output: () => string; readonly stop: () => Promise<number | null> }

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
  return { output: () => output, stop };
}

async function until(condition: () => boolean, label: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const count = (output: string, pattern: RegExp): number => output.split('\n').filter((line) => pattern.test(line)).length;

test('golem build --watch rebuilds once per edit, reports an error, recovers, and sees a new file', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
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

test('golem build --watch generates before it rebuilds a model edit, and rebuilds any other edit without a generate job', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const root = sourceOnlyProject(t, 'build-watch-generate');
  write(root, 'src/use.ts', USE);
  const counter = countingGenerator(root);
  const before = snapshot(root);
  const watcher = watching(t, root);
  const built = (): number => count(watcher.output(), /^Built /);
  await until(() => built() === 1, 'the first build');
  assert.equal(counter.runs(), 1);
  const companion = path.join(root, 'src/money.model.generated.ts');
  assert.ok(fs.existsSync(companion), 'the first build generated the file');

  // The model source is what a generate job reads: its edit regenerates the companion, and the build that follows sees it.
  const model = path.join(root, 'src/money.model.ts');
  fs.writeFileSync(model, fs.readFileSync(model, 'utf8').replace('note: string', 'note: string; extra?: string'));
  await until(() => built() === 2, 'the rebuild after a model edit');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(built(), 2, 'one model edit triggers one rebuild, though the generate step wrote a file');
  assert.equal(counter.runs(), 2);
  assert.match(fs.readFileSync(companion, 'utf8'), /extra/);
  assert.match(fs.readFileSync(path.join(root, 'build/money.model.generated.js'), 'utf8'), /extra/, 'the build compiled the regenerated file');

  const generatedAt = fs.statSync(companion, { bigint: true }).mtimeNs;
  write(root, 'src/use.ts', `${USE}export const second = 2;\n`);
  await until(() => built() === 3, 'the rebuild after a source edit');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(built(), 3, 'one edit triggers one rebuild');
  assert.equal(counter.runs(), 2, 'no generate job ran');
  assert.equal(fs.statSync(companion, { bigint: true }).mtimeNs, generatedAt);
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /second = 2/);
  assert.equal(await watcher.stop(), 130);

  const after = snapshot(root);
  for (const file of ['golem.yaml', 'package.json', 'tsconfig.json']) assert.equal(after.get(file), before.get(file), `${file} is not a file golem build owns`);
});

test('a source edited the moment the first build is announced still starts the next build', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const root = serdeProject(t, 'build-watch-announce');
  write(root, 'src/use.ts', USE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  t.after(() => clearTimeout(timer));
  const announced: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === 'string' && chunk.startsWith('Built ')) {
      announced.push(chunk);
      // Synchronously, as a program reacting to the line would: the edit lands before the build returns to its watch loop.
      if (announced.length === 1) fs.writeFileSync(path.join(root, 'src/use.ts'), `${USE}export const second = 2;\n`);
      else controller.abort();
    }
    return (stdout as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest);
  });
  await runBuild({ watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal });
  assert.equal(announced.length, 2, 'the edit made at the first announcement started a second build');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /second = 2/);
});

test('a source fixed while the first build is still running starts the next build', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const root = serdeProject(t, 'build-watch-first');
  write(root, 'src/use.ts', `${USE}export const wrong: number = 'text';\n`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  t.after(() => clearTimeout(timer));
  const stdout = process.stdout.write.bind(process.stdout);
  let fixed = false;
  let built = false;
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    // The compiler's report is forwarded while the first build is still running: the fix lands during it, not after it.
    if (!fixed && text.includes('error TS')) {
      fixed = true;
      fs.writeFileSync(path.join(root, 'src/use.ts'), USE);
    }
    if (text.startsWith('Built ')) { built = true; controller.abort(); }
    return (stdout as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest);
  });
  await runBuild({ watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal });
  assert.ok(fixed, 'the first build reported the type error');
  assert.ok(built, 'the fix made during the first build started a second build');
});
