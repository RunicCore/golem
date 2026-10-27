// golem build: type-checks the original sources and emits the rewritten ones, both in process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseArguments } from '#golem/cli';
import { assertMoneyCodec } from './support/rewritten-module.js';

import { command, golem } from './support/process.js';
import { write, SERDE_GOLEM_YAML, editTsconfig, serdeProject, sourceOnlyProject, countingGenerator, USE, snapshot, build, buildAndListJobs, mtimes, importBuilt, golemBuild, assertCallMap } from './support/build-project.js';

// Original sources are checked, rewritten sources are emitted

test('golem build checks the original sources and emits the rewritten ones', async (t) => {
  const root = serdeProject(t, 'build-main');
  write(root, 'src/use.ts', USE);
  write(root, 'src/plain.ts', 'export const answer: number = 42;\n');
  // The rewritten text of this file does not type-check: the codec's parse returns unknown.
  write(root, 'src/typed.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
export const typed: TMoney = parse<TMoney>('{"currency":"EUR","value":"2"}');
`);
  write(root, 'src/load.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { Payment } from './money.model.js';
export function load(t: string) { return parse<Payment>(t); }
`);
  editTsconfig(root, (tsconfig) => { tsconfig.include = ['**/*.ts']; });
  const before = snapshot(root);
  assert.deepEqual(await build(root), { exitCode: 0 });

  await t.test('the built JavaScript runs with the codec of the model', async () => {
    const built = await importBuilt(root, 'use.js');
    assert.equal(built.text, '{"currency":"USD","value":"1"}');
    assert.deepEqual(built.money, { currency: 'USD', value: '1' });
  });

  await t.test('no source file changes: bytes and mtimes stay', () => {
    assert.deepEqual(snapshot(root), before);
  });

  await t.test('a file whose rewritten text would not type-check builds, because the originals are checked', () => {
    assertMoneyCodec(path.join(root, 'build/typed.js'), 'the emitted JavaScript is the rewritten one');
  });

  await t.test('a declaration comes from the original: an inferred return type names the model class', () => {
    assert.match(fs.readFileSync(path.join(root, 'build/load.d.ts'), 'utf8'), /export declare function load\(t: string\): Payment;/);
  });

  await t.test('a source map of a rewritten call resolves to the original line and column', () => {
    assertCallMap(root, 'build/use.js', 'src/use.ts');
  });

  await t.test('a source map of a copied file names the original', () => {
    const mapFile = path.join(root, 'build/plain.js.map');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { sources: string[] };
    assert.deepEqual(map.sources.map((source) => path.resolve(path.dirname(mapFile), source)), [path.join(root, 'src/plain.ts')]);
  });
});

// Generating first, and incremental builds

test('a project with no generated file builds in one golem build, and the built JavaScript runs', async (t) => {
  const root = sourceOnlyProject(t, 'build-generates');
  write(root, 'src/use.ts', USE);
  const companion = path.join(root, 'src/money.model.generated.ts');
  assert.equal(fs.existsSync(companion), false, 'the fixture holds sources, golem.yaml and tsconfig only');
  assert.deepEqual(await build(root), { exitCode: 0 });
  assert.ok(fs.existsSync(companion), 'the build generated the file the source imports');
  const built = await importBuilt(root, 'use.js');
  assert.equal(built.text, '{"currency":"USD","value":"1"}');
  assert.deepEqual(built.money, { currency: 'USD', value: '1' });
});

test('a second build with no change runs no job and emits nothing again', async (t) => {
  const root = sourceOnlyProject(t, 'build-second');
  write(root, 'src/use.ts', USE);
  countingGenerator(root);
  const first = await buildAndListJobs(root);
  assert.equal(first.exitCode, 0);
  assert.deepEqual(first.ran, ['generator:out', 'models:.'], 'the first build ran every job');
  const companion = path.join(root, 'src/money.model.generated.ts');
  const emitted = mtimes(path.join(root, 'build'), '.js');
  assert.ok(emitted.size > 0);

  // A rewrite stamps a file with the current time, so a stamp 2 s ahead shows it without waiting for the clock.
  const ahead = new Date(Date.now() + 2_000);
  for (const file of [companion, ...[...emitted.keys()].map((name) => path.join(root, 'build', name))]) fs.utimesSync(file, ahead, ahead);
  const generatedAt = fs.statSync(companion, { bigint: true }).mtimeNs;
  const emittedAt = mtimes(path.join(root, 'build'), '.js');
  const second = await buildAndListJobs(root);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(second.ran, [], 'no job ran: the build\'s own output is no input of the models job');
  assert.equal(fs.statSync(companion, { bigint: true }).mtimeNs, generatedAt);
  assert.deepEqual(mtimes(path.join(root, 'build'), '.js'), emittedAt, 'nothing was emitted again');
});

test('a second build emits only the changed file', async (t) => {
  const root = serdeProject(t, 'build-incremental');
  write(root, 'src/use.ts', USE);
  write(root, 'src/other.ts', 'export const other = 1;\n');
  assert.equal((await build(root)).exitCode, 0);
  const first = mtimes(path.join(root, 'build'), '.js');

  const edited = `${USE}export const again = stringify<TMoney>({ currency: 'EUR', value: '2' });\n`;
  // Every emitted file carries a stamp 2 s ahead, so the one the build writes again is the one whose stamp changes.
  const ahead = new Date(Date.now() + 2_000);
  for (const file of first.keys()) fs.utimesSync(path.join(root, 'build', file), ahead, ahead);
  const stamped = mtimes(path.join(root, 'build'), '.js');
  write(root, 'src/use.ts', edited);
  assert.equal((await build(root)).exitCode, 0);
  const second = mtimes(path.join(root, 'build'), '.js');
  assert.deepEqual([...second].filter(([file, time]) => stamped.get(file) !== time).map(([file]) => file), ['use.js']);
  const built = await importBuilt(root, 'use.js');
  assert.equal(built.again, '{"currency":"EUR","value":"2"}');
});

// The compiler's own messages and the rejected -b

test('a type error fails the build with the compiler message at the original line and still emits, as tsc does', async (t) => {
  const root = serdeProject(t, 'build-error');
  write(root, 'src/use.ts', USE);
  write(root, 'src/broken.ts', "export const n: number = 'text';\n");
  const result = await golemBuild(root, []);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /src\/broken\.ts\(1,14\): error TS2322: Type 'string' is not assignable to type 'number'\./);
  assertMoneyCodec(path.join(root, 'build/use.js'), 'the rewritten JavaScript is emitted');
  assert.ok(fs.existsSync(path.join(root, 'build/broken.js')), 'so is the file with the error');
});

test('a forwarded --noEmitOnError stops the emit after a type error, and the exit status stays the compiler\'s', async (t) => {
  const root = serdeProject(t, 'build-error-no-emit');
  write(root, 'src/use.ts', USE);
  write(root, 'src/broken.ts', "export const n: number = 'text';\n");
  const result = await golemBuild(root, ['--noEmitOnError']);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /error TS2322/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'nothing is emitted');
});

test('an argument golem build sets itself is rejected with the reason and the workaround', async (t) => {
  assert.throws(() => parseArguments(['build', '--noCheck']), { message: 'golem build sets --noCheck itself (the emit program skips the type check and the check program reports the errors); a build emits JavaScript when the check fails unless noEmitOnError is set' });
  for (const flag of ['--noEmit', '--emitDeclarationOnly', '--tsBuildInfoFile', '--incremental', '--outDir', '--listEmittedFiles']) {
    assert.throws(() => parseArguments(['build', flag, 'value']), (error: Error) => error.message.startsWith(`golem build sets ${flag} itself (`) && error.message.includes('); '), flag);
  }
  // The emit program sets these: an argument would beat the tsconfig it reads. The tsconfig is where they are set.
  for (const flag of ['--baseUrl', '--composite', '--declarationDir']) {
    assert.throws(() => parseArguments(['build', flag, 'value']), (error: Error) => error.message.startsWith(`golem build sets ${flag} itself (`) && error.message.endsWith('); set it in tsconfig.json'), flag);
  }
  // outFile has no tsconfig way out: the message gives the reason and the bundle route instead.
  assert.throws(() => parseArguments(['build', '--outFile', 'all.js']), { message: 'golem build sets --outFile itself (TypeScript 7 removed outFile and TypeScript 6 deprecates it, so one build cannot write the same files on both); emit one file for each source, then bundle with esbuild or Vite and the golem plugin' });
  const root = serdeProject(t, 'build-owned-flag');
  const result = await golemBuild(root, ['--noCheck']);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem build sets --noCheck itself ('), result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'a rejected argument builds nothing');
});

test('golem build stops on parse<T> used as a value and names the file and line', async (t) => {
  // protects: F-36 an unrewritten serde call throws at run time, so the build reports each form it cannot rewrite
  const root = sourceOnlyProject(t, 'build-value-use');
  write(root, 'src/use.ts', `${USE}export const decode = parse<TMoney>;\n`);
  const result = await golemBuild(root, []);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /RUNM1079 \(src\/use\.ts:\d+:\d+\): parse<TMoney> is used as a value, which golem cannot rewrite\. Call parse<TMoney>\(\.\.\.\) directly\./);
});

test('a forwarded --declaration writes declarations from the original sources', async (t) => {
  const root = sourceOnlyProject(t, 'build-declaration-argument');
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.declaration = false; });
  write(root, 'src/use.ts', USE);
  const result = await golemBuild(root, ['--declaration']);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const declarations = fs.readFileSync(path.join(root, 'build/use.d.ts'), 'utf8');
  // The rewritten text types `parse` as unknown; the original types it as the model's object type.
  assert.match(declarations, /export declare const money: \{\s*currency: string;\s*value: string;\s*\};/);
});

test('-b and --build are rejected', async (t) => {
  assert.deepEqual(parseArguments(['build', '-b']), { action: 'build', watch: false, compilerBuild: true });
  assert.deepEqual(parseArguments(['build', '--build']), { action: 'build', watch: false, compilerBuild: true });
  const root = serdeProject(t, 'build-reject');
  const result = await golemBuild(root, ['--build']);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem build does not take -b or --build'), result.stderr);
  const watching = await golemBuild(root, ['-b', '--watch']);
  assert.equal(watching.code, 1, 'a refused -b ends a watching build too');
  assert.ok(watching.stderr.includes('golem build does not take -b or --build'), watching.stderr);
  assert.deepEqual(parseArguments(['build', '-w']), { action: 'build', watch: true }, '-w is --watch, as in tsc');
  assert.deepEqual(parseArguments(['build', '--project', 'a/tsconfig.json', '--watch']), { action: 'build', project: 'a/tsconfig.json', watch: true });
  // Every other argument goes to the compiler runs unchanged, in order.
  assert.deepEqual(parseArguments(['build', '--declaration', '-p', 'a', '--target', 'es2022', '--listFiles']), { action: 'build', watch: false, project: 'a', tscArguments: ['--declaration', '--target', 'es2022', '--listFiles'] });
  // The project is the golem.yaml's tsconfig unless -p names another one.
  assert.deepEqual(parseArguments(['build']), { action: 'build', watch: false });
  assert.deepEqual(parseArguments(['build', '--config', 'app/golem.yaml']), { action: 'build', watch: false, config: 'app/golem.yaml' });
  assert.throws(() => parseArguments(['build', '--config']), { message: '--config requires a filename.' });
});

test('golem build prints the stack and cause of an internal failure, and only the message of a condition the user fixes', async (t) => {
  // protects: T-490 the CLI entry printed errorMessage only, so a TypeError in a generator lost its stack and cause
  const root = sourceOnlyProject(t, 'build-failure-text');
  write(root, 'node_modules/@fixture/throwing/package.json', JSON.stringify({ name: '@fixture/throwing', version: '1.0.0', type: 'module', exports: { './generator': './index.js' } }));
  write(root, 'node_modules/@fixture/throwing/index.js', `export const apiVersion = 1;
export function generate() { throw new TypeError('generator state is broken', { cause: new RangeError('index out of range') }); }
`);
  write(root, 'golem.yaml', `${fs.readFileSync(path.join(root, 'golem.yaml'), 'utf8')}generators:\n  - package: '@fixture/throwing'\n    output: out\n`);
  const internal = await golemBuild(root, []);
  assert.equal(internal.code, 1);
  assert.match(internal.stderr, /TypeError: generator state is broken\n\s+at /);
  assert.match(internal.stderr, /\[cause\]: RangeError: index out of range/);

  // Conditions the user fixes print as their message: a golem.yaml key it does not know.
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: true\nmodels:\n  root: .\nunknownKey: true\n');
  const named = await golemBuild(root, []);
  assert.equal(named.code, 1);
  assert.doesNotMatch(named.stderr, /\n\s+at /);
  assert.match(named.stderr, /unknownKey/);

  // A command that does not exist reaches the top as a system error, `spawn … ENOENT`: the user fixes the command, so it prints as its message.
  write(root, 'golem.yaml', SERDE_GOLEM_YAML);
  const missing = await command(root, process.execPath, [golem, 'exec', '--', 'golem-no-such-command'], { allowFailure: true });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /spawn golem-no-such-command ENOENT/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
});
