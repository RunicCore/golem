// lane: typescript6 the project references of the TypeScript 6 program, which reads a referenced project as its declaration output; the TypeScript 7.1 lane reads it through a module resolver
// golem build builds a tsconfig that has `references` as `tsc -p` builds it. The solution tsconfig and -b stay refused, with the command for each project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { editTsconfig, build, golemBuild, serdeProject, TSC, USE, write } from './support/build-project.js';
import { command } from './support/process.js';

const SHARED_TSCONFIG = JSON.stringify({ compilerOptions: { composite: true, strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', skipLibCheck: true, outDir: 'dist', rootDir: 'src' }, include: ['src'] });

/** A serde project whose tsconfig references `shared`, a composite project with no golem.yaml. `built` runs `tsc -p shared` first. */
async function referencing(t: TestContext, name: string, built: boolean): Promise<string> {
  const root = serdeProject(t, name);
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

test('a project with a built reference builds the files tsc -p builds', async (t) => {
  // protects: T-477 references build as tsc -p builds them on both lanes
  const root = await referencing(t, 'build-references-built', true);
  assert.equal((await build(root)).exitCode, 0);
  const golemFiles = files(path.join(root, 'build'));
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  const tsc = await command(root, process.execPath, [TSC, '-p', 'tsconfig.json'], { allowFailure: true });
  assert.equal(tsc.code, 0, tsc.stdout);
  const tscFiles = files(path.join(root, 'build'));
  assert.deepEqual([...golemFiles.keys()].toSorted(), [...tscFiles.keys()].toSorted());
  for (const file of ['use.d.ts', 'use.d.ts.map']) assert.equal(golemFiles.get(file), tscFiles.get(file), file);
  assert.match(golemFiles.get('use.js')!, /from '\.\.\/shared\/src\/x\.js';/);
  assert.doesNotMatch(golemFiles.get('use.js')!, /stringify<TMoney>/, 'the call is rewritten');
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

test('a solution tsconfig and -b are refused with the command for each referenced project', async (t) => {
  // protects: T-477 a golem.yaml names one project, so the build names the others
  const root = await referencing(t, 'build-references-refused', true);
  write(root, 'solution.json', JSON.stringify({ files: [], references: [{ path: './shared' }] }));
  const command = 'shared/tsconfig.json: golem build --config shared/golem.yaml';
  const solution = await golemBuild(root, ['-p', 'solution.json']);
  assert.equal(solution.code, 1);
  assert.ok(solution.stderr.includes('solution.json only lists project references') && solution.stderr.includes(command), solution.stderr);
  const refused = await golemBuild(root, ['-b']);
  assert.equal(refused.code, 1);
  assert.ok(refused.stderr.includes(command), refused.stderr);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
});
