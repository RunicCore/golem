// golem build: the configurations it emits, rejects or leaves alone, and the decorator metadata it keeps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createFixtureProject, linkProjectPackages, readFixture } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { command, workspace } from './support/process.js';
import { MINIMAL_GOLEM_YAML } from './model-project.js';
import { TSC, HEAVY_TEST_TIMEOUT_MS, write, editTsconfig, serdeProject, PAYMENTS_CONTROLLER, USE, snapshot, build, mtimes } from './support/build-project.js';

// Output the incremental state cannot see, and configurations that differ in one directory

test('a build restores an outDir that was deleted, with its declarations and source maps', async (t) => {
  const root = serdeProject(t, 'build-deleted-outdir');
  write(root, 'src/use.ts', USE);
  assert.equal((await build(root)).exitCode, 0);
  fs.rmSync(path.join(root, 'build'), { recursive: true });
  assert.equal((await build(root)).exitCode, 0);
  for (const file of ['use.js', 'use.js.map', 'use.d.ts', 'money.model.js']) assert.ok(fs.existsSync(path.join(root, 'build', file)), `build/${file} is written again`);
});

test('a validating project runs its validation from the build output as written', async (t) => {
  const root = serdeProject(t, 'build-validating-output');
  write(root, 'src/check.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from './money.model.js';
import './money.model.js';

export const valid = parse<TMoney>('{"currency":"USD","value":"1"}', { validate: true });
export const parseInvalid = (): TMoney => parse<TMoney>('{"currency":1,"value":"1"}', { validate: true });
`);
  assert.equal((await build(root)).exitCode, 0);
  const built = await import(pathToFileURL(path.join(root, 'build/check.js')).href) as {
    readonly valid: unknown;
    readonly parseInvalid: () => unknown;
  };
  assert.deepEqual(built.valid, { currency: 'USD', value: '1' });
  assert.throws(built.parseInvalid, /Model validation failed/);
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
      'src/payments.controller.ts': PAYMENTS_CONTROLLER,
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

