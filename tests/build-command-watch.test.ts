// golem build --watch: sources outside the tsconfig directory, model edits, and edits made while a build runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runBuild } from '#golem/build';
import { createModelProject, MINIMAL_GOLEM_YAML } from './model-project.js';
import { write, serdeProject, sourceOnlyProject, countingGenerator, USE, snapshot } from './support/build-project.js';
import { workspace } from './support/process.js';
import { count, watching } from './support/build-watching.js';
import { until } from './support/watch-wait.js';

test('golem build --watch rebuilds for an edit to a source outside the tsconfig directory and for a file added beside it', async (t) => {
  const { root: outer } = createModelProject(t, { prefix: 'golem-build-watch-shared-', name: 'build-watch-shared', linkTypescript: true, packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') } });
  const app = path.join(outer, 'app');
  write(app, 'package.json', '{"name":"watch-shared-app","type":"module"}');
  write(app, 'golem.yaml', MINIMAL_GOLEM_YAML);
  write(app, 'tsconfig.json', JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, outDir: 'build', rootDir: '..' },
    include: ['src/**/*.ts', '../shared/*.ts'],
  }));
  write(app, 'src/main.ts', 'export const main: number = 1;\n');
  write(outer, 'shared/shared.ts', 'export const shared: number = 1;\n');
  const watcher = watching(t, app);
  await until(() => count(watcher.output(), /^Built /) === 1, 'the first build');
  assert.match(fs.readFileSync(path.join(app, 'build/shared/shared.js'), 'utf8'), /shared = 1/);

  write(outer, 'shared/shared.ts', 'export const shared: number = 2;\n');
  await until(() => count(watcher.output(), /^Built /) === 2, 'the rebuild after an edit outside the tsconfig directory');
  assert.match(fs.readFileSync(path.join(app, 'build/shared/shared.js'), 'utf8'), /shared = 2/);

  write(outer, 'shared/added.ts', 'export const added: number = 3;\n');
  await until(() => count(watcher.output(), /^Built /) === 3, 'the rebuild after a file was added beside the outside source');
  assert.match(fs.readFileSync(path.join(app, 'build/shared/added.js'), 'utf8'), /added = 3/);
  assert.equal(await watcher.stop(), 130);
});

test('golem build --watch regenerates and rebuilds once after a model edit; any other source edit rebuilds and reruns the models job, which reads the whole project', async (t) => {
  const root = sourceOnlyProject(t, 'build-watch-generate');
  write(root, 'src/use.ts', USE);
  countingGenerator(root);
  const before = snapshot(root);
  // In this process, so the jobs each build's generate step ran are the pipeline's own job results.
  const controller = new AbortController();
  t.after(() => controller.abort());
  const ran: string[][] = [];
  let built = 0;
  const stdout = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === 'string' && chunk.startsWith('Built ')) built += 1;
    return (stdout as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest);
  });
  let idle = 0;
  // A poll that found nothing to build has looked at every file since the last build, so a rebuild that build's own writes caused has started by then.
  const settled = async (): Promise<void> => {
    const seen = idle;
    await until(() => idle > seen, 'a poll that found nothing to build');
  };
  const finished = runBuild({ watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal, onGenerated: (jobs) => ran.push([...jobs].sort()), onIdlePoll: () => { idle += 1; } });
  await until(() => built === 1, 'the first build');
  await settled();
  assert.deepEqual(ran, [['generator:out', 'models:.']], 'the first build ran every job and its writes started no rebuild');
  const companion = path.join(root, 'src/money.model.generated.ts');
  assert.ok(fs.existsSync(companion), 'the first build generated the file');

  // The model source is what both jobs read: its edit regenerates the companion, and the build that follows sees it.
  const model = path.join(root, 'src/money.model.ts');
  fs.writeFileSync(model, fs.readFileSync(model, 'utf8').replace('note: string', 'note: string; extra?: string'));
  await until(() => built === 2, 'the rebuild after a model edit');
  await settled();
  assert.deepEqual(ran.slice(1), [['generator:out', 'models:.']], 'both jobs read the model source, and one model edit triggers one rebuild though the generate step wrote a file');
  assert.match(fs.readFileSync(companion, 'utf8'), /extra/);
  assert.match(fs.readFileSync(path.join(root, 'build/money.model.generated.js'), 'utf8'), /extra/, 'the build compiled the regenerated file');

  // The models job's program reads the whole project, so `use.ts` is one of its inputs; the generator reads only the model.
  write(root, 'src/use.ts', `${USE}export const second = 2;\n`);
  await until(() => built === 3, 'the rebuild after a source edit');
  await settled();
  assert.deepEqual(ran.slice(1), [['generator:out', 'models:.'], ['models:.']], 'one source edit triggers one rebuild; the models job ran again and the generator did not');
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /second = 2/);
  controller.abort();
  assert.equal((await finished).exitCode, 0);
  assert.equal(built, 3, 'no edit started a build beyond the three');

  const after = snapshot(root);
  for (const file of ['golem.yaml', 'package.json', 'tsconfig.json']) assert.equal(after.get(file), before.get(file), `${file} is not a file golem build owns`);
});

test('a source edited the moment the first build is announced still starts the next build', async (t) => {
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

test('a source fixed while the first build is still running starts the next build', async (t) => {
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
