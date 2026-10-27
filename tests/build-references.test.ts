// lane: typescript6 the project references of the TypeScript 6 program, which reads a referenced project as its declaration output; the TypeScript 7.1 lane reads it through a module resolver
// golem build builds a tsconfig that has `references` as `tsc -p` builds it. The solution tsconfig and -b stay refused, with the command for each project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { editTsconfig, build, golemBuild, SERDE_GOLEM_YAML, serdeProject, sourceOnlyProject, TSC, USE, write } from './support/build-project.js';
import { command } from './support/process.js';

const SHARED_TSCONFIG = JSON.stringify({ compilerOptions: { composite: true, strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', skipLibCheck: true, outDir: 'dist', rootDir: 'src' }, include: ['src'] });

/** A project (by default a serde project) whose tsconfig references `shared`, a composite project with no golem.yaml. `built` runs `tsc -p shared` first. */
async function referencing(t: TestContext, name: string, built: boolean, start = serdeProject): Promise<string> {
  const root = start(t, name);
  editTsconfig(root, (tsconfig) => { tsconfig.references = [{ path: './shared' }]; });
  write(root, 'shared/tsconfig.json', SHARED_TSCONFIG);
  write(root, 'shared/src/x.ts', "export const x = 'shared';\n");
  write(root, 'src/use.ts', `import { x } from '../shared/src/x.js';\nexport const marker: string = x;\n${USE}`);
  if (built) await command(root, process.execPath, [TSC, '-p', 'shared']);
  return root;
}

const files = (directory: string): Map<string, string> => new Map(fs.readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => [path.relative(directory, path.join(entry.parentPath, entry.name)), fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')]));

/** Builds `root` with golem and with `tsc -p`: the same files, and the same declaration text for `use.ts`. */
async function assertBuildsAsTsc(root: string): Promise<Map<string, string>> {
  assert.equal((await build(root)).exitCode, 0);
  const golemFiles = files(path.join(root, 'build'));
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  const tsc = await command(root, process.execPath, [TSC, '-p', 'tsconfig.json'], { allowFailure: true });
  assert.equal(tsc.code, 0, tsc.stdout);
  const tscFiles = files(path.join(root, 'build'));
  assert.deepEqual([...golemFiles.keys()].toSorted(), [...tscFiles.keys()].toSorted());
  for (const file of ['use.d.ts', 'use.d.ts.map']) assert.equal(golemFiles.get(file), tscFiles.get(file), file);
  return golemFiles;
}

test('a project with a built reference builds the files tsc -p builds', async (t) => {
  // protects: T-477 references build as tsc -p builds them on both lanes
  const golemFiles = await assertBuildsAsTsc(await referencing(t, 'build-references-built', true));
  assert.match(golemFiles.get('use.js')!, /from '\.\.\/shared\/src\/x\.js';/);
  assert.doesNotMatch(golemFiles.get('use.js')!, /stringify<TMoney>/, 'the call is rewritten');
});

test('a project reads the declaration output of a project that only its referenced project references', async (t) => {
  // protects: T-477 tsc loads the whole closure of references: a paths alias into project c reads c's output, not its source
  const root = await referencing(t, 'build-references-closure', true);
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.paths = { '@c/*': ['./c/src/*'] }; });
  write(root, 'c/tsconfig.json', SHARED_TSCONFIG);
  write(root, 'c/src/z.ts', "export const z = 'c';\n");
  write(root, 'shared/tsconfig.json', JSON.stringify({ ...JSON.parse(SHARED_TSCONFIG), references: [{ path: '../c' }] }));
  write(root, 'shared/src/x.ts', "import { z } from '../../c/src/z.js';\nexport const x: string = z;\n");
  write(root, 'src/use.ts', `import { x } from '../shared/src/x.js';\nimport { z } from '@c/z.js';\nexport const both: string = x + z;\n${USE}`);
  for (const project of ['c', 'shared']) await command(root, process.execPath, [TSC, '-p', project]);
  await assertBuildsAsTsc(root);
});

test('an import that fails for another reason does not name a project to build', async (t) => {
  // protects: T-477 the not-built line follows an import that reached an unbuilt output
  const root = await referencing(t, 'build-references-typo', true);
  write(root, 'src/typo.ts', "import './absent.js';\n");
  const result = await golemBuild(root, []);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /src\/typo\.ts\(1,\d+\): error TS/);
  assert.doesNotMatch(result.stdout, /has not been built/);
});

test('a reference that is not built gives the compiler error, names the project to build and writes nothing', async (t) => {
  // protects: T-477 a missing referenced output is an error that names the project
  const root = await referencing(t, 'build-references-unbuilt', false);
  const result = await golemBuild(root, []);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /src\/use\.ts\(1,\d+\): error TS(2307|6305)/);
  assert.match(result.stdout, /shared\/tsconfig\.json has not been built: shared\/src\/x\.ts has no declaration output\. Build it first with golem build --config shared\/golem\.yaml\.\n/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'a build that stops writes no output');
});

test('a solution tsconfig is refused with the command for each referenced project', async (t) => {
  // protects: T-477 a golem.yaml names one project, so the build names the others
  const root = await referencing(t, 'build-references-refused', true);
  write(root, 'solution.json', JSON.stringify({ files: [], references: [{ path: './shared' }] }));
  const solution = await golemBuild(root, ['-p', 'solution.json']);
  assert.equal(solution.code, 1);
  assert.ok(solution.stderr.includes('solution.json only lists project references') && solution.stderr.includes('shared/tsconfig.json: golem build --config shared/golem.yaml'), solution.stderr);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
});

/** A project that imports and parses a model of `shared`, which is outside its models job (`root: src`). */
async function parsingOutsideModel(t: TestContext, name: string, file: string): Promise<{ root: string; result: Awaited<ReturnType<typeof golemBuild>> }> {
  const root = await referencing(t, name, true, sourceOnlyProject);
  write(root, 'golem.yaml', SERDE_GOLEM_YAML.replace('root: .', 'root: src'));
  write(root, `shared/src/${file}.ts`, "import type { IObject } from '@exprtlabs/golem/model';\nexport type TOutside = IObject<{ currency: string }>;\n");
  await command(root, process.execPath, [TSC, '-p', 'shared']);
  write(root, 'src/use.ts', `import { parse } from '@exprtlabs/golem/serde';\nimport type { TOutside } from '../shared/src/${file}.js';\nexport const value = parse<TOutside>('{}');\n`);
  return { root, result: await golemBuild(root, []) };
}

test('parse<T> on a model of a referenced project gets a codec in this project when its declaration file has a model suffix', async (t) => {
  // protects: T-477 the model of a referenced project is read from its declaration file, as a model from any package is
  const { root, result } = await parsingOutsideModel(t, 'build-references-model', 'money.model');
  assert.equal(result.code, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /requireObjectCodec\("TOutside_[0-9a-f]+"\)\.parse\('\{\}'\)/);
});

test('parse<T> on a model of a referenced project stops the build when its declaration file has no model suffix', async (t) => {
  // protects: T-477 a model is read only from a file that ends in .model.ts or .models.ts
  const { root, result } = await parsingOutsideModel(t, 'build-references-no-suffix', 'money');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNM1074 \(src\/use\.ts:3:22\): shared\/dist\/money\.d\.ts#TOutside is declared in a file whose name has no model suffix/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
});
