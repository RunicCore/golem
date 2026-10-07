// golem build: the configurations it emits, rejects or leaves alone, and the decorator metadata it keeps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runPipeline } from '#golem/cli';
import { copyFixtureFile, createFixtureProject, linkProjectPackages, readFixture } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { command, workspace } from './support/process.js';
import { createModelProject, MINIMAL_GOLEM_YAML } from './model-project.js';
import { ORDER_WIRE, runSite, sharedFolderProject } from './support/shared-folder-project.js';
import { TSC, HEAVY_TEST_TIMEOUT_MS, write, editTsconfig, serdeProject, sourceOnlyProject, PAYMENTS_CONTROLLER, USE, snapshot, build, mtimes, importBuilt, assertCallMap } from './support/build-project.js';

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
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  write(root, 'golem.yaml', MINIMAL_GOLEM_YAML);
  const base = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' };
  // The golem.yaml names this tsconfig; every config below is another build of the same directory.
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...base, outDir: 'build' }, include: ['src/**/*.ts'] }));
  const config = (extra: Record<string, unknown>, name: string): string => {
    fs.writeFileSync(path.join(root, name), JSON.stringify({ compilerOptions: { ...base, outDir: 'build', ...extra }, include: ['src/**/*.ts'] }));
    return name;
  };

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


// Sources outside the tsconfig directory: every file the tsconfig includes builds, as it does under tsc

/** `outer/app`, a project whose tsconfig includes `../shared/*.ts` under `rootDir: '..'`, beside `outer/shared`. `outer` holds the linked packages the app resolves. */
function appBesideShared(t: TestContext, name: string, compilerOptions: Record<string, unknown> = {}): { readonly outer: string; readonly app: string } {
  const { root: outer } = createModelProject(t, {
    prefix: 'golem-build-shared-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
  });
  const app = path.join(outer, 'app');
  write(app, 'package.json', '{"name":"shared-app","type":"module"}');
  write(app, 'golem.yaml', MINIMAL_GOLEM_YAML);
  write(app, 'tsconfig.json', JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, declaration: true, outDir: 'build', rootDir: '..', ...compilerOptions },
    include: ['src/**/*.ts', '../shared/*.ts'],
  }));
  return { outer, app };
}

/** Every file under `directory`, by POSIX path, with its text; a link is listed as `<path> (link)` and not read. */
function filesUnder(directory: string): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const relative = path.relative(directory, filename).split(path.sep).join('/');
      if (entry.isSymbolicLink()) found[`${relative} (link)`] = fs.realpathSync(filename);
      else if (entry.isDirectory()) visit(filename);
      else found[relative] = fs.readFileSync(filename, 'utf8');
    }
  };
  visit(directory);
  return Object.fromEntries(Object.entries(found).sort(([left], [right]) => (left < right ? -1 : 1)));
}

/** What a plain `tsc -p tsconfig.json` emits for the project, beside the golem build's own output. */
async function plainTscOutput(app: string): Promise<Record<string, string>> {
  await command(app, process.execPath, [TSC, '-p', 'tsconfig.json', '--outDir', 'plain']);
  return filesUnder(path.join(app, 'plain'));
}

test('a tsconfig that includes ../shared builds the output tree that tsc emits, and the JavaScript runs', async (t) => {
  const { outer, app } = appBesideShared(t, 'build-shared-tree');
  write(app, 'src/main.ts', "import { shared } from '../../shared/shared.js';\nexport const doubled: number = shared * 2;\n");
  write(outer, 'shared/shared.ts', 'export const shared: number = 21;\n');

  assert.equal((await build(app)).exitCode, 0);
  const built = filesUnder(path.join(app, 'build'));
  assert.deepEqual(Object.keys(built), ['app/src/main.d.ts', 'app/src/main.js', 'shared/shared.d.ts', 'shared/shared.js']);
  assert.deepEqual(built, await plainTscOutput(app));
  assert.equal((await importBuilt(app, 'app/src/main.js')).doubled, 42);
});

test('an app model with fields of plain shared types generates, builds and runs', async (t) => {
  const { outer, app } = appBesideShared(t, 'build-shared-fields');
  write(outer, 'shared/money.ts', 'export type TMoneyFields = { currency: string; value: string };\n');
  write(outer, 'shared/payment.ts', "import type { TMoneyFields } from './money.js';\nexport type TPaymentFields = { id: string; note: string; paid: TMoneyFields };\n");
  write(app, 'src/order.model.ts', `import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { TMoneyFields } from '../../shared/money.js';
import type { TPaymentFields } from '../../shared/payment.js';
export type TMoney = IObject<TMoneyFields>;
export type TPayment = IModel<TPaymentFields>;
export type TOrder = IModel<{ total: TMoney; payment: TPayment }>;
`);
  write(app, 'src/main.ts', `import { parse, stringify } from '@exprtlabs/golem/serde';
import type { TOrder } from './order.model.js';
import './order.model.generated.js';

export const text = stringify<TOrder>({ total: { currency: 'USD', value: '5' }, payment: { id: 'p1', note: 'paid', paid: { currency: 'USD', value: '5' } } });
export const order = parse<TOrder>(text);
`);

  assert.equal((await build(app)).exitCode, 0);
  assert.deepEqual((await importBuilt(app, 'app/src/main.js')).order, { total: { currency: 'USD', value: '5' }, payment: { id: 'p1', note: 'paid', paid: { currency: 'USD', value: '5' } } });
  assert.deepEqual(fs.readdirSync(path.join(outer, 'shared')).sort(), ['money.ts', 'payment.ts'], 'golem wrote nothing into the shared folder');
});

test('a declaration file outside the project, imported under a rootDir inside it, builds the layout tsc emits', async (t) => {
  // The compiler leaves a declaration file out of the rootDir check, so a project that only imports one keeps its own layout.
  const { outer, app } = appBesideShared(t, 'build-shared-declaration', { rootDir: 'src' });
  write(app, 'src/main.ts', "import { typed } from '../../shared/typed.js';\nexport const value: number = typed;\n");
  write(outer, 'shared/typed.d.ts', 'export declare const typed: number;\n');
  editTsconfig(app, (tsconfig) => { tsconfig.include = ['src/**/*.ts']; });
  assert.equal((await build(app)).exitCode, 0);
  const built = filesUnder(path.join(app, 'build'));
  assert.deepEqual(Object.keys(built), ['main.d.ts', 'main.js']);
  assert.deepEqual(built, await plainTscOutput(app));
});

test('an outside source under a folder without a package.json is CommonJS in the stage, as in its place', async (t) => {
  const { outer, app } = appBesideShared(t, 'build-shared-no-manifest');
  // The app is ESM; nothing from the shared folder up to the filesystem root has a package.json.
  fs.rmSync(path.join(outer, 'package.json'));
  write(app, 'src/main.ts', 'export const main: number = 1;\n');
  write(outer, 'shared/util.ts', 'export const value: number = 2;\n');

  assert.equal((await build(app)).exitCode, 0);
  const built = filesUnder(path.join(app, 'build'));
  assert.match(built['shared/util.js']!, /exports\.value = /);
  assert.deepEqual(built, await plainTscOutput(app));
});

test('an outside source resolves its own package.json and node_modules in the stage as it does in its place', async (t) => {
  const { outer, app } = appBesideShared(t, 'build-shared-packages', { experimentalDecorators: true, emitDecoratorMetadata: true });
  // Everything above the shared folder is CommonJS, so a module the stage emits as ESM got its type from the shared folder's own package.json.
  write(outer, 'package.json', '{"private":true}');
  write(app, 'package.json', '{"name":"shared-app"}');
  write(app, 'src/main.ts', 'export const main: number = 1;\n');
  write(outer, 'shared/package.json', JSON.stringify({ type: 'module', imports: { '#helper': './helper.js' } }));
  write(outer, 'shared/helper.ts', 'export class Helper { readonly name: string = \'helper\'; }\n');
  // A property decorator's metadata names a class the compiler resolves, and is `Object` for one it cannot.
  write(outer, 'shared/util.ts', `import { Dep } from '@fixture/dep';
import { Helper } from '#helper';
declare function mark(target: object, key: string): void;
export class User {
  @mark dep?: Dep;
  @mark helper?: Helper;
}
`);
  write(outer, 'shared/node_modules/@fixture/dep/package.json', '{"name":"@fixture/dep","version":"1.0.0","types":"./index.d.ts"}');
  write(outer, 'shared/node_modules/@fixture/dep/index.d.ts', 'export declare class Dep { readonly name: string }\n');

  assert.equal((await build(app)).exitCode, 0);
  const built = filesUnder(path.join(app, 'build'));
  assert.deepEqual(built['shared/util.js']!.match(/__metadata\("design:type", \w+\)/g), ['__metadata("design:type", Dep)', '__metadata("design:type", Helper)']);
  assert.deepEqual(built, await plainTscOutput(app));
});

test('a workspace library reached only by import is neither staged nor emitted, as under tsc', async (t) => {
  const { outer, app } = appBesideShared(t, 'build-shared-library');
  write(app, 'src/main.ts', 'export const main: number = 1;\n');
  write(outer, 'packages/lib/package.json', JSON.stringify({ name: '@fixture/lib', type: 'module', types: './src/index.ts', exports: { '.': { types: './src/index.ts', default: './src/index.js' } } }));
  write(outer, 'packages/lib/src/index.ts', 'export const read = (): number => 7;\n');
  write(outer, 'shared/util.ts', "import { read } from '@fixture/lib';\nexport const value: number = read();\n");
  fs.mkdirSync(path.join(outer, 'shared/node_modules/@fixture'), { recursive: true });
  fs.symlinkSync(path.join(outer, 'packages/lib'), path.join(outer, 'shared/node_modules/@fixture/lib'), 'dir');

  assert.equal((await build(app)).exitCode, 0);
  const built = filesUnder(path.join(app, 'build'));
  assert.deepEqual(Object.keys(built), ['app/src/main.d.ts', 'app/src/main.js', 'shared/util.d.ts', 'shared/util.js']);
  assert.deepEqual(built, await plainTscOutput(app));
  // The stage holds the program's sources, the package.json files and links the originals have, and the stage's own tsconfig.
  assert.deepEqual(Object.keys(filesUnder(path.join(app, '.golem/build/tsconfig/stage'))), [
    'app/package.json',
    'app/src/main.ts',
    'node_modules (link)',
    'package.json',
    'shared/node_modules (link)',
    'shared/util.ts',
    'tsconfig.json',
  ]);
});

test('a staged copy of a source that left the program is pruned and the node_modules its stage linked to is left alone', async (t) => {
  const { outer, app } = appBesideShared(t, 'build-shared-prune');
  write(app, 'src/main.ts', 'export const main: number = 1;\n');
  write(outer, 'shared/util.ts', "import { Dep } from '@fixture/dep';\nexport const value = (dep: Dep): string => dep.name;\n");
  write(outer, 'shared/node_modules/@fixture/dep/package.json', '{"name":"@fixture/dep","version":"1.0.0","types":"./index.d.ts"}');
  write(outer, 'shared/node_modules/@fixture/dep/index.d.ts', 'export interface Dep { readonly name: string }\n');
  const stage = path.join(app, '.golem/build/tsconfig/stage');
  const dependency = filesUnder(path.join(outer, 'shared/node_modules'));

  assert.equal((await build(app)).exitCode, 0);
  assert.ok(Object.keys(filesUnder(stage)).includes('shared/node_modules (link)'), 'the stage links the outside node_modules');

  editTsconfig(app, (tsconfig) => { tsconfig.include = ['src/**/*.ts']; tsconfig.compilerOptions.rootDir = 'src'; });
  assert.equal((await build(app)).exitCode, 0);
  assert.deepEqual(Object.keys(filesUnder(stage)), ['package.json', 'src/main.ts', 'tsconfig.json']);
  assert.deepEqual(filesUnder(path.join(outer, 'shared/node_modules')), dependency, 'the linked directory keeps its files');
  assert.equal(fs.readFileSync(path.join(outer, 'shared/util.ts'), 'utf8'), "import { Dep } from '@fixture/dep';\nexport const value = (dep: Dep): string => dep.name;\n");
});

test('a rewrite site in a source outside the tsconfig directory passes golem check, is rewritten by golem build, and its source map names the original file and line', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const { outer, app } = appBesideShared(t, 'build-shared-site', { sourceMap: true });
  copyFixtureFile(app, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(app, 'src/main.ts', "export const main: number = 1;\n");
  write(outer, 'shared/site.ts', USE.replaceAll("'./money.model.js'", "'../app/src/money.model.js'"));
  const config = path.join(app, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });

  assert.equal((await build(app)).exitCode, 0);
  const built = fs.readFileSync(path.join(app, 'build/shared/site.js'), 'utf8');
  assert.match(built, /export const money = __golem_requireObjectCodec\("TMoney_[0-9a-f]+"\)\.parse\(text\);/);
  assert.deepEqual((await importBuilt(app, 'shared/site.js')).money, { currency: 'USD', value: '1' });
  assertCallMap(app, 'build/shared/site.js', '../shared/site.ts');
});

// Two apps, one shared folder of plain types: each app declares its own models and has its own profile

const CONFIG_OF = (app: string): string => path.join(app, 'golem.yaml');

test('each app builds and runs a model over the shared plain types under its own profile', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const project = sharedFolderProject(t, 'shared-folder-run');
  for (const app of [project.appA, project.appB]) {
    await runPipeline(CONFIG_OF(app));
    await runPipeline(CONFIG_OF(app), { check: true });
    assert.equal((await build(app)).exitCode, 0);
  }
  assert.deepEqual(fs.readdirSync(path.join(project.shared, 'src')).sort(), ['money.ts'], 'golem wrote nothing into the shared folder');

  const appA = await runSite(project.appA, path.join(project.appA, 'build/a/src/site.js'));
  assert.deepEqual(appA.wire, ORDER_WIRE);
  assert.equal(appA.validityObservable, true, 'the MobX validator hook of the layer is on');
  assert.equal(appA.accepted, null);
  assert.match(appA.rejected ?? '', /Model validation failed/, 'app A rejects the currency "US"');

  const appB = await runSite(project.appB, path.join(project.appB, 'build/apps/deep/b/src/site.js'));
  assert.deepEqual(appB, { wire: null, validityObservable: null, accepted: { currency: 'US', value: '5' }, rejected: null });
});

test('tsc type-checks both apps with no paths entry', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const project = sharedFolderProject(t, 'shared-folder-tsc');
  for (const app of [project.appA, project.appB]) {
    await runPipeline(CONFIG_OF(app));
    const tsconfig = JSON.parse(fs.readFileSync(path.join(app, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    assert.equal(tsconfig.compilerOptions.paths, undefined);
    await command(app, process.execPath, [TSC, '-p', 'tsconfig.json', '--noEmit']);
  }
});

test('an app built with plain tsc runs its generated models under node with no imports entry', { timeout: HEAVY_TEST_TIMEOUT_MS }, async (t) => {
  const { appA } = sharedFolderProject(t, 'shared-folder-plain-tsc');
  write(appA, 'src/plain.ts', `import { parseTMoney } from './order.model.generated.js';

export const money = parseTMoney('{"currency":"USD","value":"5"}');
export const parseShortCurrency = (): unknown => parseTMoney('{"currency":"US","value":"5"}');
`);
  await runPipeline(CONFIG_OF(appA));
  await command(appA, process.execPath, [TSC, '-p', 'tsconfig.json']);
  const script = "import('./build/a/src/plain.js').then((plain) => { let rejected = null; try { plain.parseShortCurrency(); } catch (error) { rejected = error.message; } console.log(JSON.stringify({ money: plain.money, rejected })); });";
  const result = await command(appA, process.execPath, ['--input-type=module', '--eval', script]);
  const outcome = JSON.parse(result.stdout) as { readonly money: unknown; readonly rejected: string | null };
  assert.deepEqual(outcome.money, { currency: 'USD', value: '5' });
  assert.match(outcome.rejected ?? '', /Model validation failed/);
});

test('a project with no shared folder needs no new configuration', async (t) => {
  const root = sourceOnlyProject(t, 'shared-folder-none');
  write(root, 'golem.yaml', MINIMAL_GOLEM_YAML);
  write(root, 'src/use.ts', USE);
  await runPipeline(CONFIG_OF(root));
  assert.equal((await build(root)).exitCode, 0);
  const result = await command(root, process.execPath, ['--input-type=module', '--eval', "import('./build/use.js').then((use) => console.log(JSON.stringify(use.money)));"]);
  assert.equal(result.stdout, '{"currency":"USD","value":"1"}\n');
});
