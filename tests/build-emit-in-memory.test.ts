// lane: typescript6 the emit program of golem build: JavaScript and maps emitted to memory, written only when they differ from the disk
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';
import { runBuild } from '#golem/build';
import { command } from './support/process.js';
import { TSC, write, serdeProject, USE, build, mtimes, golemBuild } from './support/build-project.js';

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

test('no tsc process starts for a build that emits', async (t) => {
  // protects: T-462 the emit runs in process: the check, the declarations and the JavaScript start no tsc
  const root = serdeProject(t, 'build-emit-no-tsc');
  write(root, 'src/use.ts', USE);
  const spawn = mock.method(childProcess, 'spawn');
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await runBuild({ watch: false, config: path.join(root, 'golem.yaml') }), { exitCode: 0 });
  assert.ok(fs.existsSync(path.join(root, 'build/use.js')) && fs.existsSync(path.join(root, 'build/use.d.ts')));
  const compilerRuns = spawn.mock.calls.filter((call) => (call.arguments[1] as readonly unknown[] | undefined)?.some((argument) => typeof argument === 'string' && argument.endsWith(path.join('bin', 'tsc'))));
  assert.equal(compilerRuns.length, 0);
});

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
