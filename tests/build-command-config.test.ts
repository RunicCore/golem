// golem build: the golem.yaml, its tsconfig and the build state of each tsconfig.
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
  write(root, 'golem.yaml', options.yaml ?? 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: .\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'src/money.model.ts');
  write(root, 'src/use.ts', USE);
  write(root, 'src/use.test.ts', USE.replace('export const text', 'export const testText').replace('(text)', '(testText)'));
  if (options.generate !== false) await runPipeline(path.join(root, 'golem.yaml'));
  return root;
}

test('each tsconfig of the directory keeps its own build state', async (t) => {
  const root = await generatedProject(t, 'build-two-configs');
  fs.writeFileSync(path.join(root, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.json', exclude: ['src/**/*.test.ts'] }));

  assert.equal((await build(root, 'tsconfig.build.json')).exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'build/use.test.js')), false);

  assert.equal((await build(root)).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/use.test.js')));
  for (const name of ['tsconfig', 'tsconfig.build']) assert.ok(fs.existsSync(path.join(root, '.golem/build', name, 'emit.tsbuildinfo')), `${name} has its own state`);
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
      'packages/api/golem.yaml': 'version: 1\ntsconfig: ../../tsconfig.json\nmodels: { root: . }\ncontrollers:\n  - root: .\n    output: generated/api.json\n    info: { title: Payments, version: "1" }\n',
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
  const root = await generatedProject(t, name, { yaml: 'version: 1\nmobx: false\nvalidation: false\ntsconfig: ./tsconfig.json\nmodels:\n  root: .\n', generate: false });
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
  assert.ok(fs.existsSync(path.join(root, '.golem/build/tsconfig/emit.tsbuildinfo')));

  assert.equal((await build(root, 'tsconfig.all.json')).exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'build/use.test.js')));
});

test('a tsconfig key that differs from the tsconfig the job finds from its root fails in golem generate, golem check and golem build', async (t) => {
  const root = await generatedProject(t, 'build-differing-tsconfig', { yaml: 'version: 1\nmobx: false\nvalidation: false\ntsconfig: ./tsconfig.app.json\nmodels:\n  root: .\n', generate: false });
  fs.writeFileSync(path.join(root, 'tsconfig.app.json'), JSON.stringify({ extends: './tsconfig.json', exclude: ['src/**/*.test.ts'] }));
  const yaml = path.join(root, 'golem.yaml');
  const real = fs.realpathSync(root);
  const unsupported = (error: Error): boolean => {
    assert.ok(error.message.includes(path.join(real, 'tsconfig.app.json')), error.message);
    assert.ok(error.message.includes(path.join(real, 'tsconfig.json')), error.message);
    assert.match(error.message, /is not supported yet/);
    return true;
  };
  await assert.rejects(runPipeline(yaml), unsupported);
  await assert.rejects(runPipeline(yaml, { check: true }), unsupported);
  await assert.rejects(build(root), unsupported);
  const result = await golemBuild(root, []);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /is not supported yet/);
  assert.equal(fs.existsSync(path.join(root, '.golem')), false, 'a refused configuration writes no state');
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'and no build');
});

test('a job root outside the directory of the yaml tsconfig fails in golem generate, golem check and golem build', async (t) => {
  const root = await generatedProject(t, 'build-job-root-outside', { yaml: 'version: 1\nmobx: false\nvalidation: false\ntsconfig: ./app/tsconfig.json\nmodels:\n  root: .\n', generate: false });
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app/tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json', include: ['../src/**/*.ts'] }));
  const yaml = path.join(root, 'golem.yaml');
  const outside = (error: Error): boolean => {
    assert.equal(error.message, `job root ${fs.realpathSync(root)} is outside ${path.join(fs.realpathSync(root), 'app')}; use one golem.yaml per tsconfig.`);
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
  assert.ok(fs.existsSync(path.join(root, '.golem/build/tsconfig/stage/src/use.ts')));
  assert.equal(fs.existsSync(path.join(root, 'shared/.golem')), false, 'build state lives beside the symlink');
});

test('a declaration-only project with a declarationDir rebuilds nothing when nothing changed', async (t) => {
  const root = serdeProject(t, 'build-declaration-dir');
  write(root, 'src/use.ts', USE);
  editTsconfig(root, (tsconfig) => { tsconfig.compilerOptions.emitDeclarationOnly = true; tsconfig.compilerOptions.declarationDir = 'types'; });
  assert.equal((await build(root)).exitCode, 0);
  const first = mtimes(path.join(root, 'types'), '.d.ts');
  assert.ok(first.has('use.d.ts'));
  assert.equal(fs.existsSync(path.join(root, 'build')), false, 'no JavaScript, so no outDir');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await build(root)).exitCode, 0);
  assert.deepEqual(mtimes(path.join(root, 'types'), '.d.ts'), first, 'a build with no change writes no declaration');

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
  for (const name of ['a', 'b']) {
    for (const file of ['payment.model.ts', 'payment.model.generated.ts', 'iobject-plugin-keys.ts', 'calls.ts']) copyFixtureFile(root, `rewrite/${file}`, `packages/${name}/src/${file}`);
    write(root, `packages/${name}/package.json`, JSON.stringify({ name, private: true, type: 'module' }));
  }
  assert.equal((await build(root)).exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'packages/a/.golem')), false);
  for (const name of ['a', 'b']) assert.match(fs.readFileSync(path.join(root, `build/packages/${name}/src/calls.js`), 'utf8'), /requireObjectCodec\("TMoney_11111111"\)\.stringify\(/);
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
  write(root, 'golem.yaml', 'version: 1\nmobx: false\nvalidation: false\nmodels:\n  root: packages/a\n');
  copyFixtureFile(root, 'models/serde/base-payment-model/money.model.ts', 'packages/a/src/money.model.ts');
  write(root, 'packages/a/src/use.ts', USE);
  // A sibling package that the same tsconfig includes: its sites are not outside the tsconfig directory.
  for (const file of ['payment.model.ts', 'payment.model.generated.ts', 'iobject-plugin-keys.ts', 'calls.ts']) copyFixtureFile(root, `rewrite/${file}`, `packages/b/src/${file}`);

  await runPipeline(path.join(root, 'golem.yaml'));
  assert.equal(fs.existsSync(path.join(root, 'packages/a/.golem')), false, 'the package gets no state of its own');

  assert.equal((await build(root)).exitCode, 0);
  assert.match(fs.readFileSync(path.join(root, 'build/packages/a/src/use.js'), 'utf8'), /requireObjectCodec\("TMoney_[0-9a-f]{8}"\)\.stringify\(/);
  assert.match(fs.readFileSync(path.join(root, 'build/packages/b/src/calls.js'), 'utf8'), /requireObjectCodec\("TMoney_11111111"\)\.stringify\(/);
});

