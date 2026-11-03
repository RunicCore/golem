// lane: typescript6 the build.ts emit through the TypeScript 6 compiler, which resolves rootDirs and lays out the files the build compares with tsc -p
// golem build accepts rootDirs: the compiler resolves a relative import through the virtual folders, and the build leaves a specifier alone
// when the plain relative path does not reach its target. The files are the ones `tsc -p` writes for the same project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileFixtureScope, onceShared } from './fixture-project.js';
import { createModelProject, MINIMAL_GOLEM_YAML } from './model-project.js';
import { build, TSC, write } from './support/build-project.js';
import { command, workspace } from './support/process.js';

const scope = fileFixtureScope();

const files = (root: string): string[] => fs.readdirSync(path.join(root, 'build'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(path.join(root, 'build'), path.join(entry.parentPath, entry.name)))
  .toSorted();
const text = (root: string, file: string): string => fs.readFileSync(path.join(root, 'build', file), 'utf8');

/**
 * A Bundler project whose `src` and `gen` folders are one virtual folder. `src/api.ts` imports `./plain` (a project source in
 * `src`), `./generated` (a project source in `gen`) and `./typed` (a declaration file in `gen`).
 */
const built = onceShared(async () => {
  const { root } = createModelProject(scope, {
    prefix: 'golem-build-root-dirs-',
    name: 'build-root-dirs',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    rootDir: '.',
    include: ['src/**/*.ts', 'gen/**/*.ts'],
    compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', declaration: true, sourceMap: true, rootDirs: ['src', 'gen'] },
  });
  write(root, 'golem.yaml', MINIMAL_GOLEM_YAML);
  write(root, 'src/plain.ts', 'export const plain = 1;\n');
  write(root, 'src/api.ts', "export { plain } from './plain';\nexport { generated } from './generated';\nexport type { Typed } from './typed';\n");
  write(root, 'gen/generated.ts', 'export const generated = 2;\n');
  write(root, 'gen/typed.d.ts', 'export interface Typed { readonly kind: string }\n');
  const result = await build(root);
  const golemFiles = files(root);
  const golem = Object.fromEntries(golemFiles.filter((file) => file.endsWith('.js') || file.endsWith('.d.ts')).map((file) => [file, text(root, file)]));
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json'], { allowFailure: true });
  return { exitCode: result.exitCode, golemFiles, golem, tscFiles: files(root), tsc: (file: string) => text(root, file) };
});

test('golem build accepts rootDirs', async () => {
  // protects: T-476 the rootDirs refusal is gone
  assert.equal((await built()).exitCode, 0);
});

test('a specifier that rootDirs resolves into another folder stays as written, and a declaration file stays', async () => {
  // protects: T-476 the plain path does not reach the target, so the emitted files do not sit side by side
  const { golem, tsc } = await built();
  assert.match(golem['src/api.js']!, /from '\.\/generated';/);
  assert.match(golem['src/api.d.ts']!, /from '\.\/generated';/);
  assert.match(golem['src/api.d.ts']!, /from '\.\/typed';/);
  assert.match(tsc('src/api.js'), /from '\.\/generated';/);
});

test('a project source that the plain path reaches gets the extension of its output', async () => {
  // protects: T-476 the existing specifier rule holds beside a cross-folder specifier
  const { golem } = await built();
  assert.match(golem['src/api.js']!, /from '\.\/plain\.js';/);
  assert.match(golem['src/api.d.ts']!, /from '\.\/plain\.js';/);
});

test('golem build writes the files that tsc -p writes for the same rootDirs project', async () => {
  // protects: T-476 rootDirs does not change the layout, on both lanes
  const { golemFiles, tscFiles } = await built();
  assert.deepEqual(golemFiles, ['gen/generated.d.ts', 'gen/generated.js', 'gen/generated.js.map', 'src/api.d.ts', 'src/api.js', 'src/api.js.map', 'src/plain.d.ts', 'src/plain.js', 'src/plain.js.map']);
  assert.deepEqual(golemFiles, tscFiles);
});
