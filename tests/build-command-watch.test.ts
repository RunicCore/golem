// lane: typescript6 ProgramSession resolution updates in the `golem build --watch` driver
// golem build --watch: sources outside the tsconfig directory, model edits, and edits made while a build runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runBuild } from '#golem/build';
import { createModelProject, MINIMAL_GOLEM_YAML } from './model-project.js';
import { write, serdeProject, sourceOnlyProject, countingGenerator, editTsconfig, USE, snapshot } from './support/build-project.js';
import { subscribe } from './support/golem-channels.js';
import { workspace } from './support/process.js';
import { count, watching } from './support/build-watching.js';
import { quietly, until } from './support/watch-wait.js';

test('golem build --watch rebuilds for an edit to a source outside the tsconfig directory and for a file added beside it', async (t) => {
  const { root: outer } = createModelProject(t, { prefix: 'golem-build-watch-shared-', name: 'build-watch-shared', linkTypescript: true, packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') } });
  const app = path.join(outer, 'app');
  write(app, 'package.json', '{"name":"watch-shared-app","type":"module","dependencies":{"@exprtlabs/golem-model":"*"}}');
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
  // The compiler session compares file signatures, which an edit within the timestamp resolution of the file system leaves as they were: the build
  // also tells the session which files it generated.
  const hinted: string[] = [];
  subscribe(t, 'inputsChanged', (message: { readonly filenames: readonly string[] }) => { hinted.push(...message.filenames); });
  const finished = runBuild({ watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal, onGenerated: (jobs) => ran.push([...jobs].sort()) });
  const built = (name: string): string => { const file = path.join(root, 'build', name); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; };
  const companion = path.join(root, 'src/money.model.generated.ts');
  await until(() => ran.length === 1 && built('use.js') !== '' && fs.existsSync(companion), 'the first build');

  hinted.length = 0;
  // The model source is what both jobs read: its edit regenerates the companion, and the build that follows sees it.
  const model = path.join(root, 'src/money.model.ts');
  fs.writeFileSync(model, fs.readFileSync(model, 'utf8').replace('note: string', 'note: string; extra?: string'));
  await until(() => /extra/.test(built('money.model.generated.js')), 'the rebuild after a model edit');
  assert.match(fs.readFileSync(companion, 'utf8'), /extra/);
  assert.ok(hinted.includes(companion), 'the compiler session was told that the regenerated companion changed');

  // The models job's program reads the whole project, so `use.ts` is one of its inputs; the generator reads only the model.
  write(root, 'src/use.ts', `${USE}export const second = 2;\n`);
  await until(() => /second = 2/.test(built('use.js')), 'the rebuild after a source edit');
  // The builds' own writes must start no build: any that would come has come within this time.
  await quietly();
  controller.abort();
  assert.equal((await finished).exitCode, 0);
  // Both jobs read the model source, and the generator reads nothing else: the use.ts edit reran the models job alone.
  assert.deepEqual(ran, [['generator:out', 'model'], ['generator:out', 'model'], ['model']], 'each edit triggered one build, and the generate step\'s writes none');

  const after = snapshot(root);
  for (const file of ['golem.yaml', 'package.json', 'tsconfig.json']) assert.equal(after.get(file), before.get(file), `${file} is not a file golem build owns`);
});

test('a source edited the moment the first build is announced still starts the next build', async (t) => {
  const root = serdeProject(t, 'build-watch-announce');
  write(root, 'src/use.ts', USE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  t.after(() => clearTimeout(timer));
  const announced: number[] = [];
  await runBuild({
    watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal,
    onBuilt: ({ exitCode }) => {
      announced.push(exitCode);
      // Synchronously, as a program reacting to the announcement would: the edit lands before the build returns to its watch loop.
      if (announced.length === 1) fs.writeFileSync(path.join(root, 'src/use.ts'), `${USE}export const second = 2;\n`);
      else controller.abort();
    },
  });
  assert.deepEqual(announced, [0, 0], 'the edit made at the first announcement started a second build');
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
  const finished: number[] = [];
  // The only patch left: no option reports the middle of a run. The compiler's report is forwarded to stdout while the first build is still
  // running, and the fix must land then, not after the build has ended.
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (!fixed && text.includes('error TS')) {
      fixed = true;
      fs.writeFileSync(path.join(root, 'src/use.ts'), USE);
    }
    return (stdout as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest);
  });
  await runBuild({
    watch: true, config: path.join(root, 'golem.yaml'), signal: controller.signal,
    onBuilt: ({ exitCode }) => { finished.push(exitCode); if (exitCode === 0) controller.abort(); },
  });
  assert.ok(fixed, 'the first build reported the type error');
  assert.deepEqual(finished.map((code) => code === 0), [false, true], 'the first build failed on the type error; the fix made during it started a second build');
});

test('golem build --watch removes the output of a source that is deleted, and nothing else', async (t) => {
  // protects: T-315 the output of a deleted source leaves outDir
  const root = serdeProject(t, 'build-watch-delete');
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.declarationMap = true; });
  write(root, 'src/use.ts', USE);
  write(root, 'src/extra/helper.ts', 'export const helper = 1;\n');
  const watcher = watching(t, root);
  await until(() => count(watcher.output(), /^Built /) === 1, 'the first build');
  const outputs = (name: string): string[] => ['.js', '.js.map', '.d.ts', '.d.ts.map'].map((ending) => path.join(root, 'build', `${name}${ending}`));
  for (const file of [...outputs('use'), ...outputs('extra/helper')]) assert.ok(fs.existsSync(file), `${file} is built`);
  // A file in outDir that the build did not write.
  write(root, 'build/notes.txt', 'mine');

  fs.rmSync(path.join(root, 'src/use.ts'));
  await until(() => count(watcher.output(), /^Built /) === 2, 'the build after the source was deleted');
  assert.deepEqual(outputs('use').filter((file) => fs.existsSync(file)), [], 'the output of the deleted source is gone');
  assert.ok([...outputs('money.model'), ...outputs('extra/helper')].every((file) => fs.existsSync(file)), 'the output of the other sources stays');
  assert.equal(fs.readFileSync(path.join(root, 'build/notes.txt'), 'utf8'), 'mine');

  fs.rmSync(path.join(root, 'src/extra/helper.ts'));
  await until(() => count(watcher.output(), /^Built /) === 3, 'the build after the last source of a folder was deleted');
  assert.equal(fs.existsSync(path.join(root, 'build/extra')), false, 'the folder the deletion left empty is gone');
  assert.equal(await watcher.stop(), 130);
});

test('golem build --watch without a rootDir removes the output of a deleted source from build/src, and leaves a file another tool wrote', async (t) => {
  // protects: T-315 only the files the build emitted for the deleted source are removed
  const root = serdeProject(t, 'build-watch-delete-layout');
  // Sources in two folders: with no rootDir, the compiler lays out from the tsconfig folder, so outputs land in build/src and build/tools.
  editTsconfig(root, (tsconfig) => { delete tsconfig.compilerOptions.rootDir; tsconfig.include = ['src/**/*.ts', 'tools/**/*.ts']; });
  write(root, 'tools/probe.ts', 'export const probe = 1;\n');
  write(root, 'src/use.ts', USE);
  write(root, 'src/index.ts', 'export const index = 1;\n');
  const watcher = watching(t, root);
  await until(() => count(watcher.output(), /^Built /) === 1, () => `the first build (output=${watcher.output()})`);
  const outputs = (name: string): string[] => ['.js', '.js.map', '.d.ts'].map((ending) => path.join(root, 'build/src', `${name}${ending}`));
  for (const file of [...outputs('index'), ...outputs('use')]) assert.ok(fs.existsSync(file), `${file} is built`);
  // Files of another tool, at the path a layout from the sources' folder would give to src/index.ts.
  write(root, 'build/index.js', 'other tool');
  write(root, 'build/index.js.map', 'other tool');

  fs.rmSync(path.join(root, 'src/index.ts'));
  await until(() => count(watcher.output(), /^Built /) === 2, 'the build after the source was deleted');
  assert.deepEqual(outputs('index').filter((file) => fs.existsSync(file)), [], 'the output of the deleted source is gone');
  assert.ok(outputs('use').every((file) => fs.existsSync(file)), 'the output of the other source stays');
  assert.equal(fs.readFileSync(path.join(root, 'build/index.js'), 'utf8'), 'other tool');
  assert.equal(fs.readFileSync(path.join(root, 'build/index.js.map'), 'utf8'), 'other tool');
  assert.equal(await watcher.stop(), 130);
});

test('golem build --watch builds again for a package manager marker and for a source in a new folder, and for nothing written inside node_modules', async (t) => {
  // protects: R-31 installed files are not watched; an install is told by its marker and builds everything again
  const root = serdeProject(t, 'build-watch-install');
  write(root, 'src/use.ts', USE);
  const watcher = watching(t, root);
  await until(() => count(watcher.output(), /^Built /) === 1, 'the first build');

  write(root, 'node_modules/some-package/index.js', 'module.exports = 1;\n');
  write(root, 'node_modules/other.json', '{}');
  await quietly();
  assert.equal(count(watcher.output(), /^Built /), 1, 'files written inside node_modules started no build');

  write(root, 'node_modules/.package-lock.json', '{}');
  await until(() => count(watcher.output(), /^Built /) === 2, 'the build after the install marker');

  write(root, 'src/extra/added.ts', 'export const added: number = 1;\n');
  await until(() => count(watcher.output(), /^Built /) === 3, 'the build after a source was added in a new folder');
  assert.match(fs.readFileSync(path.join(root, 'build/extra/added.js'), 'utf8'), /added = 1/);
  await quietly();
  assert.equal(count(watcher.output(), /^Built /), 3, 'the builds\' own writes started no build');
  assert.equal(await watcher.stop(), 130);
});

for (const [where, base] of [['outside the tsconfig directory', '../tsconfig.base.json'], ['with a hidden name', './.tsconfig.base.json']] as const) {
  test(`golem build --watch builds again for an edit to the config that its tsconfig extends, ${where}`, async (t) => {
    // protects: R-31 an input outside the root that is no source, or has a hidden name, still starts a build
    const { root: outer } = createModelProject(t, { prefix: 'golem-build-watch-base-', name: 'build-watch-base', linkTypescript: true, packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') } });
    const app = path.join(outer, 'app');
    write(app, 'package.json', '{"name":"watch-base-app","type":"module","dependencies":{"@exprtlabs/golem-model":"*"}}');
    write(app, 'golem.yaml', MINIMAL_GOLEM_YAML);
    const baseFile = path.join(app, base);
    fs.writeFileSync(baseFile, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true } }));
    write(app, 'tsconfig.json', JSON.stringify({ extends: base, compilerOptions: { outDir: 'build', rootDir: 'src' }, include: ['src/**/*.ts'] }));
    write(app, 'src/main.ts', 'export const main: number = 1;\n');
    const watcher = watching(t, app);
    await until(() => count(watcher.output(), /^Built /) === 1, () => `the first build (${watcher.output()})`);

    fs.writeFileSync(baseFile, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true } }));
    await until(() => count(watcher.output(), /^Built /) === 2, 'the build after the extended config was edited');
    assert.equal(await watcher.stop(), 130);
  });
}

test('golem build --watch that can watch no folder reports it and ends with exit code 1', async (t) => {
  // protects: R-31 no working watcher ends the watch with a failure instead of an idle process
  const root = serdeProject(t, 'build-watch-unwatchable');
  // The file system refuses every watch: the preload makes `fs.watch` throw in the build process, not in this one.
  const refuse = path.join(root, 'refuse-watch.mjs');
  fs.writeFileSync(refuse, "import fs from 'node:fs';\nfs.watch = () => { throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' }); };\n");
  const watcher = watching(t, root, { NODE_OPTIONS: `--import=${pathToFileURL(refuse).href}` });
  let code: number | null | undefined;
  void watcher.exited.then((value) => { code = value; });
  await until(() => code !== undefined, () => `the watch ends by itself (output=${watcher.output()})`);
  assert.equal(code, 1);
  assert.match(watcher.output(), /fs\.inotify\.max_user_watches/);
});
