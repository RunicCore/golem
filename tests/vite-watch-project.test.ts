// The Vite plugin keeps its rewrite project across the builds of `vite build --watch` and closes it when the watch ends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { build as vite } from 'vite';

import { runPipeline } from '#golem/cli';
import { golem as vitePlugin } from '#golem/vite';
import { copyFixtureFile, writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { subscribe } from './support/golem-channels.js';
import { workspace } from './support/process.js';
import { until } from './support/watch-wait.js';

const MAIN = `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
import './money.model.js';

export const money = parse<TMoney>('{"currency":"USD","value":"1"}');
`;

/** A generated project with one entry that parses a model. */
async function generatedProject(t: TestContext, name: string): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-vite-watch-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    compilerOptions: { noEmit: true },
  });
  const write = (relative: string, content: string): void => writeGeneratedArtifacts([{ path: path.join(root, relative), content }]);
  write('golem.yaml', 'version: 1\nvalidation: false\nmodel: {}\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write('src/main.ts', MAIN);
  await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

/** The compiler sessions the plugin has opened a program in, and how many sessions were disposed, counted from the point of the call. */
function countSessions(t: TestContext): { readonly opened: () => number; readonly disposed: () => number } {
  const sessions = new Set<object>();
  let disposed = 0;
  subscribe(t, 'programOpened', (message: { readonly session: object }) => { sessions.add(message.session); });
  subscribe(t, 'sessionDisposed', () => { disposed += 1; });
  return { opened: () => sessions.size, disposed: () => disposed };
}

/** What `vite build` returns in watch mode. */
type Watcher = Extract<Awaited<ReturnType<typeof vite>>, { close(): Promise<void> }>;

interface Run { readonly bundle: string; readonly built: () => number; readonly watcher: Watcher }

/** `vite build --watch` of the project's entry; `built` counts the finished builds. */
async function watching(t: TestContext, root: string, outDir: string): Promise<Run> {
  const result = await vite({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [vitePlugin()],
    build: { watch: {}, lib: { entry: 'src/main.ts', formats: ['es'], fileName: () => 'main.mjs' }, outDir, emptyOutDir: true, minify: false },
  });
  const watcher = result as Watcher;
  let built = 0;
  watcher.on('event', (event) => { if (event.code === 'END') built += 1; });
  t.after(() => watcher.close());
  await until(() => built === 1, 'the first build');
  return { bundle: path.join(outDir, 'main.mjs'), built: () => built, watcher };
}

test('vite build --watch: a rebuild reuses the project of the first build', async (t) => {
  // protects: T-424 the project dropped at each closeBundle was opened again, about 130 ms of a rebuild
  const root = await generatedProject(t, 'keeps-project');
  const sessions = countSessions(t);
  const run = await watching(t, root, path.join(root, 'out'));
  assert.equal(sessions.opened(), 1);
  // A change that the watcher misses before it is ready is made again until a second build ends.
  let edits = 0;
  await until(() => {
    if (run.built() < 2) writeGeneratedArtifacts([{ path: path.join(root, 'src/main.ts'), content: `${MAIN}export const edit = ${edits += 1};\n` }]);
    return run.built() >= 2;
  }, 'the rebuild after an edit');
  assert.equal(sessions.opened(), 1, 'the rebuild opened a program in the session of the first build');
  assert.equal(sessions.disposed(), 0, 'the project stayed open between builds');
});

test('vite build --watch: a model regenerated between builds reaches the next bundle through the kept project', async (t) => {
  // protects: T-424 the kept project must see a change on disk that the dropped one read afresh
  const root = await generatedProject(t, 'kept-sees-regeneration');
  const run = await watching(t, root, path.join(root, 'out'));
  // A rebuild empties the output folder before it writes the bundle, so the file can be missing for a moment.
  const idIn = (file: string): string | undefined => (fs.existsSync(file) ? /TMoney_[0-9a-f]+/.exec(fs.readFileSync(file, 'utf8'))?.[0] : undefined);
  const oldId = idIn(run.bundle);
  assert.ok(oldId, 'the first bundle names the codec of TMoney');
  const model = path.join(root, 'src/money.model.ts');
  writeGeneratedArtifacts([{ path: model, content: fs.readFileSync(model, 'utf8').replace('value: string }>', 'value: string; note?: string }>') }]);
  await runPipeline(path.join(root, 'golem.yaml'));
  await until(() => { const id = idIn(run.bundle); return id !== undefined && id !== oldId; }, 'a bundle with the regenerated codec');
});

test('vite build --watch: closing the watcher closes the project', async (t) => {
  // protects: T-424 the kept project is closed when the watch ends
  const root = await generatedProject(t, 'closes-with-watch');
  const sessions = countSessions(t);
  const run = await watching(t, root, path.join(root, 'out'));
  assert.equal(sessions.disposed(), 0, 'the project is open while the watch runs');
  await run.watcher.close();
  await until(() => sessions.disposed() === 1, 'the project closed with the watch');
});

test('vite build without watch: the project closes after the bundle', async (t) => {
  // protects: T-424 a single build keeps closing its project
  const root = await generatedProject(t, 'closes-single-build');
  const sessions = countSessions(t);
  await vite({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [vitePlugin()],
    build: { lib: { entry: 'src/main.ts', formats: ['es'], fileName: () => 'main.mjs' }, outDir: path.join(root, 'out'), emptyOutDir: true, minify: false },
  });
  assert.equal(sessions.opened(), 1);
  await until(() => sessions.disposed() === 1, 'the project closed after the bundle');
});
