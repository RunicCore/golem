// golem build: type-checks the original sources with the project's own tsc, emits the rewritten ones from a staging copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseArguments } from '#golem/cli';
import { command } from './support/process.js';
import { TSC, HEAVY_TEST_TIMEOUT_MS, REJECTION, write, editTsconfig, serdeProject, sourceOnlyProject, countingGenerator, USE, snapshot, build, buildAndListJobs, mtimes, importBuilt, golemBuild, assertCallMap } from './support/build-project.js';

// Original sources are checked, rewritten sources are emitted

test('golem build checks the original sources and emits the rewritten ones', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
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
    assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
  });

  await t.test('no source file changes: bytes and mtimes stay', () => {
    assert.deepEqual(snapshot(root), before);
  });

  await t.test('a file whose rewritten text would not type-check builds, because the originals are checked', () => {
    assert.match(fs.readFileSync(path.join(root, '.golem/build/tsconfig/stage/src/typed.ts'), 'utf8'), /__golem_requireObjectCodec\(/, 'the stage holds the rewritten text');
    assert.match(fs.readFileSync(path.join(root, 'build/typed.js'), 'utf8'), /requireObjectCodec/);
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

  await t.test('the project include never reaches the stage', async () => {
    const listed = await command(root, process.execPath, [TSC, '-p', 'tsconfig.json', '--listFilesOnly']);
    const own = listed.stdout.split('\n').filter((file) => file.startsWith(root));
    assert.ok(own.some((file) => file.endsWith('src/use.ts')));
    assert.deepEqual(own.filter((file) => file.includes('.golem')), []);
  });
});

// Generating first, and incremental builds

test('a project with no generated file builds in one golem build, and the built JavaScript runs', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
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

test('a second build with no change runs no job and emits nothing again', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const root = sourceOnlyProject(t, 'build-second');
  write(root, 'src/use.ts', USE);
  countingGenerator(root);
  const first = await buildAndListJobs(root);
  assert.equal(first.exitCode, 0);
  assert.deepEqual(first.ran, ['generator:out', 'models:.'], 'the first build ran every job');
  const companion = path.join(root, 'src/money.model.generated.ts');
  const generatedAt = fs.statSync(companion, { bigint: true }).mtimeNs;
  const emitted = mtimes(path.join(root, 'build'), '.js');
  assert.ok(emitted.size > 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await buildAndListJobs(root);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(second.ran, [], 'no job ran: the build\'s own output is no input of the models job');
  assert.equal(fs.statSync(companion, { bigint: true }).mtimeNs, generatedAt);
  assert.deepEqual(mtimes(path.join(root, 'build'), '.js'), emitted, 'nothing was emitted again');
});

test('a second build emits only the changed file', async (t) => {
  const root = serdeProject(t, 'build-incremental');
  write(root, 'src/use.ts', USE);
  write(root, 'src/other.ts', 'export const other = 1;\n');
  assert.equal((await build(root)).exitCode, 0);
  const first = mtimes(path.join(root, 'build'), '.js');

  const edited = `${USE}export const again = stringify<TMoney>({ currency: 'EUR', value: '2' });\n`;
  await new Promise((resolve) => setTimeout(resolve, 20));
  write(root, 'src/use.ts', edited);
  assert.equal((await build(root)).exitCode, 0);
  const second = mtimes(path.join(root, 'build'), '.js');
  assert.deepEqual([...second].filter(([file, time]) => first.get(file) !== time).map(([file]) => file), ['use.js']);
  const built = await importBuilt(root, 'use.js');
  assert.equal(built.again, '{"currency":"EUR","value":"2"}');

  // A source that leaves the program leaves the stage too.
  fs.rmSync(path.join(root, 'src/other.ts'));
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, '.golem/build/tsconfig/stage/src/other.ts')), false);
});

// The compiler's own messages and the rejected -b

test('a type error fails the build with the compiler message at the original line and still emits, as tsc does', async (t) => {
  const root = serdeProject(t, 'build-error');
  write(root, 'src/use.ts', USE);
  write(root, 'src/broken.ts', "export const n: number = 'text';\n");
  const result = await golemBuild(root, []);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /src\/broken\.ts\(1,14\): error TS2322: Type 'string' is not assignable to type 'number'\./);
  assert.match(fs.readFileSync(path.join(root, 'build/use.js'), 'utf8'), /requireObjectCodec/, 'the rewritten JavaScript is emitted');
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
  assert.throws(() => parseArguments(['build', '--noCheck']), { message: 'golem build sets --noCheck itself (the emit run skips the type check and the check run reports the errors); a build emits JavaScript when the check fails unless noEmitOnError is set' });
  for (const flag of ['--noEmit', '--emitDeclarationOnly', '--tsBuildInfoFile', '--incremental', '--outDir', '--listEmittedFiles']) {
    assert.throws(() => parseArguments(['build', flag, 'value']), (error: Error) => error.message.startsWith(`golem build sets ${flag} itself (`) && error.message.includes('); '), flag);
  }
  // The stage tsconfig sets these: an argument would beat it. The tsconfig is where they are set.
  for (const flag of ['--rootDir', '--baseUrl', '--composite', '--outFile', '--declarationDir', '--sourceRoot', '--mapRoot', '--inlineSourceMap', '--inlineSources']) {
    assert.throws(() => parseArguments(['build', flag, 'value']), (error: Error) => error.message.startsWith(`golem build sets ${flag} itself (`) && error.message.endsWith('); set it in tsconfig.json'), flag);
  }
  const root = serdeProject(t, 'build-owned-flag');
  const result = await golemBuild(root, ['--noCheck']);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes('golem build sets --noCheck itself ('), result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'a rejected argument builds nothing');
});

test('a forwarded --declaration writes declarations from the original sources', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const root = sourceOnlyProject(t, 'build-declaration-argument');
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.declaration = false; });
  write(root, 'src/use.ts', USE);
  const result = await golemBuild(root, ['--declaration']);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const declarations = fs.readFileSync(path.join(root, 'build/use.d.ts'), 'utf8');
  // The rewritten text types `parse` as unknown; the original types it as the model's object type.
  assert.match(declarations, /export declare const money: \{\s*currency: string;\s*value: string;\s*\};/);
  assert.doesNotMatch(declarations, /unknown|__golem_/, 'declarations come from the original, not the rewritten text');
});

test('-b and --build are rejected', async (t) => {
  assert.throws(() => parseArguments(['build', '-b']), { message: REJECTION });
  assert.throws(() => parseArguments(['build', '--build']), { message: REJECTION });
  const root = serdeProject(t, 'build-reject');
  const result = await golemBuild(root, ['-b']);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(REJECTION), result.stderr);
  assert.deepEqual(parseArguments(['build', '-w']), { action: 'build', watch: true }, '-w is --watch, as in tsc');
  assert.deepEqual(parseArguments(['build', '--project', 'a/tsconfig.json', '--watch']), { action: 'build', project: 'a/tsconfig.json', watch: true });
  // Every other argument goes to the compiler runs unchanged, in order.
  assert.deepEqual(parseArguments(['build', '--declaration', '-p', 'a', '--target', 'es2022', '--listFiles']), { action: 'build', watch: false, project: 'a', tscArguments: ['--declaration', '--target', 'es2022', '--listFiles'] });
  // The project is the golem.yaml's tsconfig unless -p names another one.
  assert.deepEqual(parseArguments(['build']), { action: 'build', watch: false });
  assert.deepEqual(parseArguments(['build', '--config', 'app/golem.yaml']), { action: 'build', watch: false, config: 'app/golem.yaml' });
  assert.throws(() => parseArguments(['build', '--config']), { message: '--config requires a filename.' });
});
