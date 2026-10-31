// golem build: the golem.yaml and its tsconfig.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import { runBuild } from '#golem/build';
import { generate } from '#model/generator';
import { copyFixtureFile, readFixture } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { createModelProject, MINIMAL_GOLEM_YAML } from './model-project.js';
import { command, golem, workspace } from './support/process.js';
import { assertMoneyCodec } from './support/rewritten-module.js';

import { write, editTsconfig, serdeProject, PAYMENTS_CONTROLLER, USE, build, mtimes, golemBuild, assertCallMap } from './support/build-project.js';

/** A project with a golem.yaml whose models job generates the serde model, and the files golem generate wrote. */
async function generatedProject(t: TestContext, name: string, options: { readonly yaml?: string; readonly generate?: boolean } = {}): Promise<string> {
  const { root } = createModelProject(t, {
    prefix: 'golem-build-generated-',
    name,
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    compilerOptions: { declaration: true, sourceMap: true },
  });
  write(root, 'golem.yaml', options.yaml ?? 'version: 1\nvalidation: false\nmodel: {}\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'src/use.ts', USE);
  write(root, 'src/use.test.ts', USE.replace('export const text', 'export const testText').replace('(text)', '(testText)'));
  if (options.generate !== false) await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

test('each tsconfig of the directory builds its own files', async (t) => {
  const root = await generatedProject(t, 'build-two-configs');
  fs.writeFileSync(path.join(root, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json', exclude: ['src/**/*.test.ts'] }));

  assert.equal((await build(root, 'tsconfig.build.json')).exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'build/use.test.js')), false);

  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/use.test.js')));
});

test('golem build --config from the parent folder builds the yaml tsconfig and keeps the Nest decorators', async (t) => {
  const nest = 'controllers/nest-plugin/project';
  const root = createControllerFixture(t, {
    prefix: 'golem-build-nest-config-',
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
        rootDir: '.',
        types: ['node'],
      },
      include: ['packages/*/src/**/*.ts'],
    },
    files: {
      'packages/api/src/payment.model.ts': readFixture(`${nest}/payment.model.ts`),
      'packages/api/src/payments.controller.ts': PAYMENTS_CONTROLLER,
      'packages/api/golem.yaml': 'version: 1\ntsconfig: ../../tsconfig.json\nmodel: {}\nts-openapi:\n  docs:\n    - output: generated/api.json\n      info: { title: Payments, version: "1" }\n',
    },
  });
  const config = path.join(root, 'packages/api/golem.yaml');
  await runPipeline(config);

  // No -p, and the working directory is the parent folder: the yaml alone decides the project.
  const result = await golemBuild(root, ['--config', 'packages/api/golem.yaml']);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.match(fs.readFileSync(path.join(root, 'build/packages/api/src/payments.controller.js'), 'utf8'), /nestModelCodec/);
});

test('golem build starts from a golem.yaml: without one it fails, and it never searches above the working directory', async (t) => {
  const root = serdeProject(t, 'build-no-yaml');
  write(root, 'src/use.ts', USE);
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  const message = 'golem build needs a golem.yaml; run it next to one or pass --config';
  // The folder above has a golem.yaml and the tsconfig; neither is found from here.
  for (const args of [[], ['-p', '../tsconfig.json']]) {
    const result = await command(nested, process.execPath, [golem, 'build', ...args], { allowFailure: true });
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes(message), result.stderr);
  }
  await assert.rejects(runBuild({ project: path.join(root, 'tsconfig.json'), watch: false, config: path.join(nested, 'golem.yaml') }), /golem build cannot find .*golem\.yaml/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
  assert.equal(fs.existsSync(path.join(root, '.golem/build')), false);
});

test('-p may name another build config of the yaml project, and only one in the directory of its tsconfig', async (t) => {
  const root = await generatedProject(t, 'build-project-directory');
  fs.mkdirSync(path.join(root, 'configs'));
  fs.writeFileSync(path.join(root, 'configs/tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json', compilerOptions: { outDir: '../build' }, include: ['../src/**/*.ts'] }));
  await assert.rejects(build(root, 'configs/tsconfig.json'), /same directory as .*tsconfig\.json/);
  assert.equal(fs.existsSync(path.join(root, 'build')), false);
});

/** The yaml names `tsconfig.json`, which leaves the tests out, beside `tsconfig.all.json`, which includes them. */
async function projectWithNamedTsconfig(t: TestContext, name: string): Promise<string> {
  const root = await generatedProject(t, name, { yaml: 'version: 1\nvalidation: false\ntsconfig: ./tsconfig.json\nmodel: {}\n', generate: false });
  editTsconfig(root, (tsconfig) => { tsconfig.exclude = ['src/**/*.test.ts']; });
  fs.writeFileSync(path.join(root, 'tsconfig.all.json'), JSON.stringify({ extends: './tsconfig.json', exclude: [] }));
  await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

test('a tsconfig key names the project that golem build builds', async (t) => {
  const root = await projectWithNamedTsconfig(t, 'build-named-tsconfig');
  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/use.js')));
  assert.equal(fs.existsSync(path.join(root, 'build/use.test.js')), false, 'the default project is the yaml tsconfig');

  assert.equal((await build(root, 'tsconfig.all.json')).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/use.test.js')));
});

test('a tsconfig key that names a build tsconfig with a paths alias generates and builds', async (t) => {
  // protects: T-480 the models job reads the tsconfig golem.yaml names, not the nearest one
  const root = await generatedProject(t, 'build-named-paths-tsconfig', { yaml: 'version: 1\nvalidation: false\ntsconfig: ./tsconfig.build.json\nmodel: {}\n', generate: false });
  fs.writeFileSync(path.join(root, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: { paths: { '@lib/*': ['./src/lib/*'] } } }));
  write(root, 'src/lib/ids.ts', 'export type Id = string;\n');
  write(root, 'src/item.model.ts', "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Id } from '@lib/ids.js';\nexport type TItem = IModel<{ id: Id }>;\n");
  await runPipeline(path.join(root, 'golem.yaml'));
  assert.ok(fs.existsSync(path.join(root, 'src/item.model.generated.ts')), 'the model that uses the alias generated');
  assert.equal((await build(root)).exitCode, 0);
});

test('a job root outside the directory of the yaml tsconfig fails in golem generate, golem check and golem build', async (t) => {
  // protects: T-375 the build error names its local files relative to the working directory
  const root = await generatedProject(t, 'build-job-root-outside', { yaml: 'version: 1\nvalidation: false\ntsconfig: ./app/tsconfig.json\nmodel: {}\n', generate: false });
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app/tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json', include: ['../src/**/*.ts'] }));
  const yaml = path.join(root, 'golem.yaml');
  const outside = (error: Error): boolean => {
    assert.equal(error.message, `job root ${path.relative(process.cwd(), fs.realpathSync(root))} is outside ${path.relative(process.cwd(), path.join(fs.realpathSync(root), 'app'))}; use one golem.yaml per tsconfig.`);
    return true;
  };
  await assert.rejects(runPipeline(yaml), outside);
  await assert.rejects(runPipeline(yaml, { check: true }), outside);
  await assert.rejects(build(root), outside);
  assert.equal(fs.existsSync(path.join(root, '.golem')), false);
});

test('a symlinked tsconfig keeps its own directory as the project root', async (t) => {
  const root = await generatedProject(t, 'build-symlinked-tsconfig');
  // The real file sits in a subdirectory: a root taken from its real path would be `shared`, with no sources.
  fs.mkdirSync(path.join(root, 'shared'));
  fs.renameSync(path.join(root, 'tsconfig.json'), path.join(root, 'shared/tsconfig.real.json'));
  fs.symlinkSync(path.join('shared', 'tsconfig.real.json'), path.join(root, 'tsconfig.json'));
  await runPipeline(path.join(root, 'golem.yaml'));
  assert.equal(fs.existsSync(path.join(root, 'shared/.golem')), false);

  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/use.js')));
  assert.equal(fs.existsSync(path.join(root, 'shared/.golem')), false, 'the build writes nothing beside the real file');
});

test('a declaration-only project with a declarationDir rebuilds nothing when nothing changed', async (t) => {
  const root = serdeProject(t, 'build-declaration-dir');
  write(root, 'src/use.ts', USE);
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.emitDeclarationOnly = true; tsconfig.compilerOptions.declarationDir = 'types'; });
  assert.equal((await build(root)).exitCode, 0);
  const first = mtimes(path.join(root, 'types'), '.d.ts');
  assert.ok(first.has('use.d.ts'));
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'no JavaScript, so no outDir');
  // A rewrite stamps a file with the current time, so a stamp 2 s ahead shows it without waiting for the clock.
  const ahead = new Date(Date.now() + 2_000);
  for (const file of first.keys()) fs.utimesSync(path.join(root, 'types', file), ahead, ahead);
  const stamped = mtimes(path.join(root, 'types'), '.d.ts');
  assert.equal((await build(root)).exitCode, 0);
  assert.deepEqual(mtimes(path.join(root, 'types'), '.d.ts'), stamped, 'a build with no change writes no declaration');

  // The declarations directory is what a build writes: deleting it restores it.
  fs.rmSync(path.join(root, 'types'), { recursive: true });
  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'types/use.d.ts')));
});

test('a source map of an .mts file names the original and resolves the rewritten call', async (t) => {
  const root = serdeProject(t, 'build-mts');
  write(root, 'src/mod.mts', USE);
  editTsconfig(root, (tsconfig) => { tsconfig.include = ['src/**/*.ts', 'src/**/*.mts']; });
  assert.equal((await build(root)).exitCode, 0);
  assertCallMap(root, 'build/mod.mjs', 'src/mod.mts');
});

// The root

test('a parent tsconfig builds every package under it, and no package gets build state of its own', async (t) => {
  const { root } = createModelProject(t, { prefix: 'golem-build-monorepo-', name: 'build-monorepo', linkTypescript: true, packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') }, rootDir: '.', include: ['packages/*/src/**/*.ts'] });
  write(root, 'golem.yaml', MINIMAL_GOLEM_YAML);
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'packages/a/src/money.model.ts');
  for (const name of ['a', 'b']) {
    write(root, `packages/${name}/src/use.ts`, name === 'a' ? USE : USE.replace(/\.\/money\.model\.js/g, '../../a/src/money.model.js'));
    write(root, `packages/${name}/package.json`, JSON.stringify({ name, private: true, type: 'module' }));
  }
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'packages/a/.golem')), false);
  for (const name of ['a', 'b']) assertMoneyCodec(path.join(root, `build/packages/${name}/src/use.js`));
});

test('a package without a tsconfig of its own, under a parent tsconfig, builds with the build state of the parent', async (t) => {
  const { root } = createModelProject(t, {
    prefix: 'golem-build-package-',
    name: 'build-package',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
    rootDir: '.',
    include: ['packages/*/src/**/*.ts'],
  });
  write(root, 'golem.yaml', 'version: 1\nvalidation: false\nmodel:\n  sources: [packages/a/src/money.model.ts]\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'packages/a/src/money.model.ts');
  write(root, 'packages/a/src/use.ts', USE);
  // A sibling package that the same tsconfig includes: its sites are not outside the tsconfig directory. It uses the model of package a.
  write(root, 'packages/b/src/use.ts', USE.replace(/\.\/money\.model\.js/g, '../../a/src/money.model.js'));

  await runPipeline(path.join(root, 'golem.yaml'));
  assert.equal(fs.existsSync(path.join(root, 'packages/a/.golem')), false, 'the package gets no state of its own');

  assert.equal((await build(root)).exitCode, 0);
  assertMoneyCodec(path.join(root, 'build/packages/a/src/use.js'));
  assertMoneyCodec(path.join(root, 'build/packages/b/src/use.js'));
});


/** An app folder with its package.json, the `tsconfig` text the case needs, a golem.yaml with a model block, and the base money model. */
function writeApp(app: string, name: string, tsconfig: string): void {
  write(app, 'package.json', JSON.stringify({ name, type: 'module', dependencies: { '@exprtlabs/golem-model': '*' } }));
  write(app, 'tsconfig.json', tsconfig);
  write(app, 'golem.yaml', 'version: 1\nvalidation: false\nmodel: {}\n');
  copyFixtureFile(app, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
}

test('a symlinked workspace package outside the tsconfig directory passes golem check and builds: both scan only the sources the build emits', async (t) => {
  // The package's `types` is its source, so the compiler reads it as an external library: the app's build does not emit it, and its check does not scan it.
  const { root: outer } = createModelProject(t, {
    prefix: 'golem-build-linked-package-',
    name: 'build-linked-package',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
  });
  const app = path.join(outer, 'app');
  write(outer, 'packages/lib/package.json', JSON.stringify({ name: '@fixture/lib', type: 'module', types: './src/index.ts', exports: { '.': { types: './src/index.ts', default: './src/index.js' } } }));
  write(outer, 'packages/lib/src/index.ts', `import { parse } from '@exprtlabs/golem/serde';
export function read(text: string): unknown { return parse<{ note: string }>(text); }
`);
  fs.mkdirSync(path.join(app, 'node_modules/@fixture'), { recursive: true });
  fs.symlinkSync(path.join(outer, 'packages/lib'), path.join(app, 'node_modules/@fixture/lib'), 'dir');
  writeApp(app, 'linked-app', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, outDir: 'build', rootDir: 'src' },
    include: ['src/**/*.ts'],
  }));
  write(app, 'src/use.ts', USE.replace("import './money.model.js';", "import './money.model.js';\nimport { read } from '@fixture/lib';\nexport const fromLibrary = read('{}');"));
  await runPipeline(path.join(app, 'golem.yaml'));

  await runPipeline(path.join(app, 'golem.yaml'), { check: true });
  assert.equal((await build(app)).exitCode, 0);
  assertMoneyCodec(path.join(app, 'build/use.js'), 'the app\'s own sites are rewritten');
});

test('a source without a rewrite site that the tsconfig includes outside its directory passes golem check and builds, whatever the project emits', async (t) => {
  const { root: outer } = createModelProject(t, {
    prefix: 'golem-build-outside-source-',
    name: 'build-outside-source',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
  });
  const app = path.join(outer, 'app');
  writeApp(app, 'outside-app', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, outDir: 'build', rootDir: 'src' },
    include: ['src/**/*.ts'],
  }));
  write(app, 'src/use.ts', USE);
  const config = path.join(app, 'golem.yaml');
  await runPipeline(config);
  await runPipeline(config, { check: true });

  // A declaration file outside the root is not subject to rootDir, so the compiler accepts it, and so do the check and the build.
  write(outer, 'shared/typings.d.ts', 'export declare const typed: number;\n');
  editTsconfig(app, (tsconfig) => { tsconfig.include = ['src/**/*.ts', '../shared/typings.d.ts']; });
  await runPipeline(config, { check: true });
  assert.equal((await build(app)).exitCode, 0);
  assertMoneyCodec(path.join(app, 'build/use.js'), 'the app\'s own sites are rewritten');

  // A TypeScript source outside the root: the rootDir that holds it sets the layout, as it does under tsc.
  write(outer, 'shared/plain.ts', 'export const plain = 1;\n');
  editTsconfig(app, (tsconfig) => {
    tsconfig.compilerOptions.rootDir = '..';
    tsconfig.include = ['src/**/*.ts', '../shared/plain.ts'];
  });
  await runPipeline(config, { check: true });
  assert.equal((await build(app)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(app, 'build/shared/plain.js')), 'the outside source is emitted beside the app');
  assert.ok(fs.existsSync(path.join(app, 'build/app/src/use.js')), 'the app moves under the rootDir');

  // A project that emits no JavaScript, a bundler's type check for one, is checked the same way.
  editTsconfig(app, (tsconfig) => { tsconfig.compilerOptions.noEmit = true; });
  await runPipeline(config, { check: true });
  editTsconfig(app, (tsconfig) => {
    delete tsconfig.compilerOptions.noEmit;
    tsconfig.compilerOptions.declaration = true;
    tsconfig.compilerOptions.emitDeclarationOnly = true;
  });
  await runPipeline(config, { check: true });
});

test('a rewrite site in a source outside the tsconfig directory passes golem check under noEmit, and golem build rewrites it', async (t) => {
  const { root: outer } = createModelProject(t, {
    prefix: 'golem-build-outside-site-',
    name: 'build-outside-site',
    linkTypescript: true,
    packages: { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') },
  });
  const app = path.join(outer, 'app');
  writeApp(app, 'outside-app', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, noEmit: true },
    include: ['src/**/*.ts', '../shared/site.ts'],
  }));
  const config = path.join(app, 'golem.yaml');
  await runPipeline(config);
  write(outer, 'shared/site.ts', `import { parse } from '@exprtlabs/golem/serde';
import type { TMoney } from '../app/src/money.model.js';
declare const text: string;
export const money = parse<TMoney>(text);
`);
  await runPipeline(config, { check: true });

  editTsconfig(app, (tsconfig) => {
    delete tsconfig.compilerOptions.noEmit;
    tsconfig.compilerOptions.outDir = 'build';
    tsconfig.compilerOptions.rootDir = '..';
  });
  assert.equal((await build(app)).exitCode, 0);
  assertMoneyCodec(path.join(app, 'build/shared/site.js'), undefined, ['text']);
});
