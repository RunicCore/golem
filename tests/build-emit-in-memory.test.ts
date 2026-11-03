// lane: typescript6 the emit program of golem build: JavaScript and maps emitted to memory, written only when they differ from the disk, in place
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { command } from './support/process.js';
import { TSC, write, editTsconfig, serdeProject, USE, build, mtimes, golemBuild } from './support/build-project.js';

const OLD = new Date('2001-01-01T00:00:00Z');
const OLD_NS = BigInt(OLD.getTime()) * 1_000_000n;

/** A project with a file that has a call to rewrite and a file that has none, built once, every output stamped with an old time. */
async function builtProject(t: TestContext, name: string): Promise<{ root: string; outputs: Map<string, string> }> {
  const root = serdeProject(t, name);
  write(root, 'src/use.ts', USE);
  write(root, 'src/plain.ts', 'export const answer: number = 42;\n');
  assert.deepEqual(await build(root), { exitCode: 0 });
  const outputs = contents(path.join(root, 'build'));
  for (const file of outputs.keys()) fs.utimesSync(path.join(root, 'build', file), OLD, OLD);
  return { root, outputs };
}

/** Every file under `directory`, by relative path, with its text. */
function contents(directory: string): Map<string, string> {
  return new Map([...mtimes(directory, '').keys()].map((file) => [file, fs.readFileSync(path.join(directory, file), 'utf8')]));
}

test('a build with nothing changed writes no output, and an output another tool overwrote is written again', async (t) => {
  // protects: T-462 each output is compared with the disk, not with the last build
  const { root, outputs } = await builtProject(t, 'build-emit-compare-disk');
  const buildDirectory = path.join(root, 'build');
  assert.ok([...outputs.keys()].some((file) => file.endsWith('.js.map')) && [...outputs.keys()].some((file) => file.endsWith('.d.ts')), 'the build writes JavaScript, declarations and maps');

  assert.deepEqual(await build(root), { exitCode: 0 });
  assert.deepEqual([...mtimes(buildDirectory, '').values()].filter((time) => time !== OLD_NS), [], 'no file was written again');

  // Plain tsc writes the JavaScript of the original sources over the rewritten one.
  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json']);
  assert.notEqual(fs.readFileSync(path.join(buildDirectory, 'use.js'), 'utf8'), outputs.get('use.js'));
  assert.deepEqual(await build(root), { exitCode: 0 });
  assert.deepEqual(contents(buildDirectory), outputs, 'the build wrote every output as it was');
});

test('a build that fails before its emit leaves the outputs of the build before as they were', async (t) => {
  // protects: T-462 a failed build writes no output
  const { root, outputs } = await builtProject(t, 'build-emit-failed');
  write(root, 'src/use.ts', `${USE}export const wrong: number = 'text';\n`);
  const result = await golemBuild(root, ['--noEmitOnError']);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /src\/use\.ts\(\d+,\d+\): error TS2322/);
  assert.deepEqual(contents(path.join(root, 'build')), outputs);
  assert.deepEqual([...mtimes(path.join(root, 'build'), '').values()].filter((time) => time !== OLD_NS), []);
});

test('a build that cannot write an output names the file', async (t) => {
  // protects: T-462 a write error stops the build and names the file
  const root = serdeProject(t, 'build-emit-write-error');
  write(root, 'src/use.ts', USE);
  write(root, 'build/use.js/inside.txt', 'a directory where the output belongs');
  await assert.rejects(build(root), /golem build could not write .*build\/use\.js: /);
});

for (const option of ['incremental', 'composite'] as const) {
  test(`a project with ${option} set gets no tsbuildinfo file from the build`, async (t) => {
    // protects: T-462 golem keeps no TypeScript build state: a build info file the compiler hands out is not written
    const root = serdeProject(t, `build-emit-${option}`);
    write(root, 'src/use.ts', USE);
    editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions[option] = true; });
    assert.deepEqual(await build(root), { exitCode: 0 });
    assert.ok(fs.existsSync(path.join(root, 'build/use.js')));
    const written = fs.readdirSync(root, { recursive: true, withFileTypes: false }).map(String).filter((file) => !file.startsWith('node_modules'));
    assert.deepEqual(written.filter((file) => file.endsWith('.tsbuildinfo')), []);
  });
}

test('a build removes the staged copy and the build state that a golem build before it kept, and nothing else under .golem', async (t) => {
  // protects: T-462 the old stage and tsbuildinfo files under .golem/build are golem's own leftovers
  const root = serdeProject(t, 'build-emit-old-state');
  write(root, 'src/use.ts', USE);
  assert.deepEqual(await build(root), { exitCode: 0 });
  const old = path.join(root, '.golem/build/tsconfig');
  write(root, '.golem/build/tsconfig/stage/src/use.ts', 'staged text');
  write(root, '.golem/build/tsconfig/emit.tsbuildinfo', '{}');
  write(root, '.golem/build/tsconfig/check.tsbuildinfo', '{}');
  write(root, '.golem/build/tsconfig.build/emit.tsbuildinfo', '{}');
  write(root, 'linked/keep.txt', 'the project folder the stage links to');
  fs.symlinkSync(path.join(root, 'linked'), path.join(old, 'stage/linked'), 'dir');
  const under = (): string[] => fs.readdirSync(path.join(root, '.golem'), { recursive: true }).map(String).sort();
  const before = under();
  assert.deepEqual(await build(root), { exitCode: 0 });
  assert.ok(before.includes('build/tsconfig.build/emit.tsbuildinfo'));
  const removed = ['build/tsconfig', 'build/tsconfig/check.tsbuildinfo', 'build/tsconfig/emit.tsbuildinfo', 'build/tsconfig/stage', 'build/tsconfig/stage/linked', 'build/tsconfig/stage/linked/keep.txt', 'build/tsconfig/stage/src', 'build/tsconfig/stage/src/use.ts'];
  assert.deepEqual(under(), before.filter((file) => !removed.includes(file)), 'the state of another tsconfig and the files of the jobs stay');
  assert.equal(fs.readFileSync(path.join(root, 'linked/keep.txt'), 'utf8'), 'the project folder the stage links to');
});

test('an output keeps its mode and a linked output stays a link when the build writes it again', async (t) => {
  // protects: T-462 tsc wrote in place: a postbuild chmod and a link in outDir survive a rebuild
  const { root } = await builtProject(t, 'build-emit-in-place');
  const built = path.join(root, 'build');
  fs.chmodSync(path.join(built, 'use.js'), 0o755);
  fs.mkdirSync(path.join(built, 'target'));
  fs.renameSync(path.join(built, 'plain.js'), path.join(built, 'target/plain.js'));
  fs.symlinkSync(path.join(built, 'target/plain.js'), path.join(built, 'plain.js'));
  write(root, 'src/use.ts', `${USE}export const again = stringify<TMoney>({ currency: 'EUR', value: '2' });\n`);
  write(root, 'src/plain.ts', 'export const answer: number = 43;\n');
  assert.deepEqual(await build(root), { exitCode: 0 });
  assert.match(fs.readFileSync(path.join(built, 'use.js'), 'utf8'), /again/);
  assert.equal(fs.statSync(path.join(built, 'use.js')).mode & 0o777, 0o755);
  assert.equal(fs.lstatSync(path.join(built, 'plain.js')).isSymbolicLink(), true);
  assert.match(fs.readFileSync(path.join(built, 'target/plain.js'), 'utf8'), /answer = 43/);
});

test('a JSON file the sources import is copied into outDir, as tsc copies it', async (t) => {
  // protects: T-462 the in-memory emit carries the JSON copies that tsc writes
  const root = serdeProject(t, 'build-emit-json');
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.resolveJsonModule = true; });
  write(root, 'src/data.json', '{ "name": "golem" }\n');
  write(root, 'src/use.ts', "import data from './data.json' with { type: 'json' };\nexport const name: string = data.name;\n");
  assert.deepEqual(await build(root), { exitCode: 0 });
  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json', '--outDir', 'plain']);
  assert.equal(fs.readFileSync(path.join(root, 'build/data.json'), 'utf8'), fs.readFileSync(path.join(root, 'plain/data.json'), 'utf8'));
  assert.match(fs.readFileSync(path.join(root, 'build/data.json'), 'utf8'), /"name": "golem"/);
});

test('leftovers of an older build that cannot be removed are reported, and the build goes on', async (t) => {
  // protects: T-462 the cleanup of the old stage is best effort
  const root = serdeProject(t, 'build-emit-old-state-stuck');
  write(root, 'src/use.ts', USE);
  write(root, '.golem/build', 'a file where the folder of the old state was');
  const result = await golemBuild(root, []);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /golem build could not remove .*tsconfig, which an older golem build left/);
  assert.ok(fs.existsSync(path.join(root, 'build/use.js')));
});
