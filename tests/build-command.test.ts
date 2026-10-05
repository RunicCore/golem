// golem build: type-checks the original sources with the project's own tsc, emits the rewritten ones from a staging copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseArguments } from '#golem/cli';
import { createFixtureProject, linkProjectPackages, readFixture } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { command, workspace } from './support/process.js';
import { MINIMAL_GOLEM_YAML } from './model-project.js';
import { TSC, HEAVY_TEST_TIMEOUT_MS, REJECTION, write, editTsconfig, serdeProject, sourceOnlyProject, countingGenerator, USE, snapshot, build, mtimes, importBuilt, golemBuild, assertCallMap } from './support/build-project.js';

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

test('a second build with no change runs no generate job and emits nothing again', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const root = sourceOnlyProject(t, 'build-second');
  write(root, 'src/use.ts', USE);
  const counter = countingGenerator(root);
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(counter.runs(), 1);
  const companion = path.join(root, 'src/money.model.generated.ts');
  const generatedAt = fs.statSync(companion, { bigint: true }).mtimeNs;
  const emitted = mtimes(path.join(root, 'build'), '.js');
  assert.ok(emitted.size > 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(counter.runs(), 1, 'no generate job ran');
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
  assert.match(declarations, /export declare const text: string;/);
  assert.doesNotMatch(declarations, /__golem_/, 'declarations come from the original, not the rewritten text');
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

// Output the incremental state cannot see, and configurations that differ in one directory

test('a build restores an outDir that was deleted, with its declarations and source maps', async (t) => {
  const root = serdeProject(t, 'build-deleted-outdir');
  write(root, 'src/use.ts', USE);
  assert.equal((await build(root)).exitCode, 0);
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  assert.equal((await build(root)).exitCode, 0);
  for (const file of ['use.js', 'use.js.map', 'use.d.ts', 'money.model.js']) assert.ok(fs.existsSync(path.join(root, 'build', file)), `build/${file} is written again`);
});

test('a class expression with a private member builds when the original does not emit declarations', async (t) => {
  const root = serdeProject(t, 'build-no-declaration');
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.declaration = false; });
  write(root, 'src/anonymous.ts', 'export const Foo = class { private x = 1; get() { return this.x; } };\n');
  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/anonymous.js')));
  assert.equal(fs.existsSync(path.join(root, 'build/anonymous.d.ts')), false);
});

// A configuration with nothing to emit

test('a noEmit or emitDeclarationOnly project is checked and writes no JavaScript and no stage', async (t) => {
  const root = serdeProject(t, 'build-no-js');
  write(root, 'src/use.ts', USE);
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.emitDeclarationOnly = true; });
  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/use.d.ts')), 'the declarations are written from the originals');
  assert.deepEqual([...mtimes(path.join(root, 'build'), '.js').keys()], []);

  editTsconfig(root, (tsconfig) => { delete tsconfig.compilerOptions.emitDeclarationOnly; tsconfig.compilerOptions.declaration = false; tsconfig.compilerOptions.noEmit = true; tsconfig.compilerOptions.outDir = 'unused'; });
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'unused')), false);
  assert.equal(fs.existsSync(path.join(root, '.golem/build/tsconfig/stage')), false, 'a check-only build stages nothing');
});

// Decorator metadata

test('a Nest controller builds with the design:paramtypes of a plain tsc emit of the original', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const nest = 'controllers/nest-plugin/project';
  const root = createControllerFixture(t, {
    prefix: 'golem-build-nest-',
    links: 'workspace',
    tsconfig: {
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
        outDir: 'build',
        rootDir: 'src',
        types: ['node'],
      },
      include: ['src/**/*.ts'],
    },
    files: {
      'src/payment.model.ts': readFixture(`${nest}/payment.model.ts`),
      'src/payments.controller.ts': `import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { TPaymentFilter, TPaymentInput, TPayment } from './payment.model.js';
@Controller('payments')
export class PaymentsController {
  @Post()
  create(@Body() input: TPaymentInput): TPayment { return { id: '1', ...input }; }
  @Get()
  list(@Query() filter: TPaymentFilter): TPayment[] { return []; }
}
`,
      'golem.yaml': 'version: 1\nmodels: { root: . }\ncontrollers:\n  - root: .\n    output: generated/api.json\n    info: { title: Payments, version: "1" }\n',
    },
  });
  assert.equal((await build(root, 'tsconfig.json', path.join(root, 'golem.yaml'))).exitCode, 0);
  await command(root, process.execPath, [TSC, '-p', 'tsconfig.json', '--outDir', 'plain']);

  const metadata = (directory: string): string[] => (fs.readFileSync(path.join(root, directory, 'payments.controller.js'), 'utf8').match(/__metadata\("design:[^\n]*\)/g) ?? []);
  const plain = metadata('plain');
  assert.ok(plain.some((line) => line.includes('design:paramtypes')), 'the controller carries parameter metadata');
  assert.deepEqual(metadata('build'), plain);
  assert.match(fs.readFileSync(path.join(root, 'build/payments.controller.js'), 'utf8'), /nestModelCodec/, 'the build carries the nest rewrite');
});

// tsconfig forms the stage supports and rejects

test('a tsconfig that extends a file outside the root, with paths and a rootDir, builds', async (t) => {
  const parent = createFixtureProject(t, 'golem-build-forms-');
  const root = path.join(parent, 'app');
  linkProjectPackages(root, { typescript: path.join(workspace, 'node_modules/typescript'), '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') });
  fs.writeFileSync(path.join(parent, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', sourceMap: true } }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  write(root, 'golem.yaml', MINIMAL_GOLEM_YAML);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    extends: '../tsconfig.base.json',
    compilerOptions: { outDir: 'build', rootDir: 'src', paths: { '@lib/*': ['./src/lib/*'] } },
    include: ['src/**/*.ts'],
  }));
  write(root, 'src/lib/answer.ts', 'export const answer: number = 42;\n');
  write(root, 'src/main.ts', "import { answer } from '@lib/answer.js';\nexport const doubled = answer * 2;\n");
  const before = snapshot(root);
  assert.equal((await build(root)).exitCode, 0);
  assert.deepEqual([...mtimes(path.join(root, 'build'), '.js').keys()].sort(), ['lib/answer.js', 'main.js']);
  assert.equal(fs.existsSync(path.join(root, 'src/lib/answer.js')), false);
  assert.deepEqual(snapshot(root), before);
});

test('golem build rejects a tsconfig the stage cannot mirror', async (t) => {
  const parent = createFixtureProject(t, 'golem-build-rejected-');
  const root = path.join(parent, 'app');
  linkProjectPackages(root, { typescript: path.join(workspace, 'node_modules/typescript'), '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') });
  fs.mkdirSync(path.join(parent, 'shared'));
  fs.writeFileSync(path.join(parent, 'shared/shared.d.ts'), 'export declare const shared: number;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  write(root, 'golem.yaml', MINIMAL_GOLEM_YAML);
  write(root, 'src/main.ts', "import { shared } from '../../shared/shared.js';\nexport const value = shared;\n");
  const base = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' };
  // The golem.yaml names this tsconfig; every config below is another build of the same directory.
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...base, outDir: 'build' }, include: ['src/**/*.ts'] }));
  const config = (extra: Record<string, unknown>, name: string): string => {
    fs.writeFileSync(path.join(root, name), JSON.stringify({ compilerOptions: { ...base, outDir: 'build', ...extra }, include: ['src/**/*.ts'] }));
    return name;
  };

  // A declaration file outside the root is not subject to rootDir, so the compiler accepts it; the stage would not reach it.
  await assert.rejects(build(root, config({ rootDir: 'src' }, 'outside.json')), (error: Error) => {
    assert.match(error.message, /shared\/shared\.d\.ts/);
    assert.match(error.message, /outside the project root/);
    return true;
  });
  await assert.rejects(build(root, config({ rootDir: '..' }, 'root-dir-outside.json')), /rootDir .* outside the project root/);
  fs.writeFileSync(path.join(root, 'no-outdir.json'), JSON.stringify({ compilerOptions: base, include: ['src/**/*.ts'] }));
  write(root, 'src/main.ts', 'export const value = 1;\n');
  await assert.rejects(build(root, 'no-outdir.json'), /requires compilerOptions\.outDir/);
  await assert.rejects(build(root, config({ rootDirs: ['src', 'other'] }, 'root-dirs.json')), /rootDirs/);
  await assert.rejects(build(root, config({ outFile: 'build/all.js' }, 'out-file.json')), /outFile/);
  await assert.rejects(build(root, config({ rootDir: 'src', sourceMap: true, sourceRoot: '/sources' }, 'source-root.json')), /sourceRoot/);
  fs.writeFileSync(path.join(root, 'solution.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.json' }] }));
  await assert.rejects(build(root, 'solution.json'), /project references/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'a rejected project writes no output');
});

