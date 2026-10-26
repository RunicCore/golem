// lane: typescript6 the output-to-source pairing of the TypeScript 6 emit, which sets the layout of the declarations and the files a deleted source takes away
// golem build takes the layout of its outputs from the compiler: each output names its source, and the build computes no layout of its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createModelProject, MINIMAL_GOLEM_YAML } from './model-project.js';
import { build, golemBuild, write } from './support/build-project.js';
import { count, watching } from './support/build-watching.js';
import { workspace } from './support/process.js';
import { until } from './support/watch-wait.js';

/** `outer/app` is the project; `outer/shared` is outside it. The Bundler options leave `./widget` without an extension, so a declaration needs the edit that adds `.js`. */
function project(t: TestContext, compilerOptions: Readonly<Record<string, unknown>>, include: readonly string[]): { outer: string; app: string } {
  const { root: outer } = createModelProject(t, { prefix: 'golem-build-layout-', name: 'build-layout', linkTypescript: true, packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') } });
  const app = path.join(outer, 'app');
  write(app, 'package.json', '{"name":"layout-app","type":"module"}');
  write(app, 'tsconfig.json', JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true, declaration: true, sourceMap: true, outDir: 'build', ...compilerOptions },
    include,
  }));
  write(app, 'golem.yaml', MINIMAL_GOLEM_YAML);
  write(app, 'src/widget.ts', 'export interface Widget { readonly size: number }\n');
  write(app, 'src/api.ts', "export * from './widget';\n");
  return { outer, app };
}

test('a declaration file outside the project with no rootDir leaves the layout at the tsconfig folder, and the declarations still get their import paths', async (t) => {
  // protects: T-474 the layout is the compiler's, not a guess from the folders of the sources
  // Sources in two folders: the compiler's layout starts at the tsconfig folder, so the outputs land in build/src and build/tools.
  const { outer, app } = project(t, {}, ['src/**/*.ts', 'tools/**/*.ts', '../shared/typings.d.ts']);
  write(app, 'tools/probe.ts', 'export const probe = 1;\n');
  write(outer, 'shared/typings.d.ts', 'export declare const typed: number;\n');
  assert.equal((await build(app)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(app, 'build/tools/probe.js')), 'the compiler lays the sources out from the tsconfig folder');
  assert.equal(fs.readFileSync(path.join(app, 'build/src/api.d.ts'), 'utf8'), "export * from './widget.js';\n");
});

test('a forwarded --rootDir gives the layout the compiler gives it, outside sources included', async (t) => {
  // protects: T-474 --rootDir is forwarded to the compiler, not refused
  const { outer, app } = project(t, {}, ['src/**/*.ts', '../shared/plain.ts']);
  write(outer, 'shared/plain.ts', 'export const plain = 1;\n');
  const result = await golemBuild(app, ['--rootDir', '..']);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.ok(fs.existsSync(path.join(app, 'build/shared/plain.js')), 'the outside source lands beside the app');
  assert.equal(fs.readFileSync(path.join(app, 'build/app/src/api.d.ts'), 'utf8'), "export * from './widget.js';\n");
});

test('golem build --watch removes the outputs of a deleted source that lies outside the project, and keeps those of the others', async (t) => {
  // protects: T-474 the outputs of a source are the files the compiler paired with it
  const { outer, app } = project(t, { rootDir: '..' }, ['src/**/*.ts', '../shared/*.ts']);
  write(outer, 'shared/plain.ts', 'export const plain = 1;\n');
  const watcher = watching(t, app);
  await until(() => count(watcher.output(), /^Built /) === 1, () => `the first build (output=${watcher.output()})`);
  const outputs = (folder: string, name: string): string[] => ['.js', '.js.map', '.d.ts'].map((ending) => path.join(app, 'build', folder, `${name}${ending}`));
  for (const file of [...outputs('shared', 'plain'), ...outputs('app/src', 'api')]) assert.ok(fs.existsSync(file), `${file} is built`);

  fs.rmSync(path.join(outer, 'shared/plain.ts'));
  await until(() => count(watcher.output(), /^Built /) === 2, () => `the build after the source was deleted (output=${watcher.output()})`);
  assert.deepEqual(outputs('shared', 'plain').filter((file) => fs.existsSync(file)), [], 'the outputs of the deleted source are gone');
  assert.equal(fs.existsSync(path.join(app, 'build/shared')), false, 'the folder the deletion left empty is gone');
  assert.ok(outputs('app/src', 'api').every((file) => fs.existsSync(file)), 'the outputs of the other source stay');
  assert.equal(await watcher.stop(), 130);
});
