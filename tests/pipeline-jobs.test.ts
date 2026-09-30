import { createFixtureProject, linkProjectPackages, snapshotFilesystem } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import { workspace } from './support/process.js';
import { writeFixture } from './support/consumer.js';
import { generate as generateModels } from '@exprtlabs/golem-model/generator';

function packageFixture(t: TestContext, { profile = { mobx: false, validation: true }, models = true } = {}): { root: string; config: string } {
  const root = createFixtureProject(t, 'runic-pipeline-jobs-');

  linkProjectPackages(root, Object.fromEntries(
    ['golem', 'golem-model', 'golem-openapi'].map(name => [`@exprtlabs/${name}`, path.join(workspace, 'packages', name)]),
  ));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"runic-pipeline-jobs-fixture","type":"module"}');
  writeFixture(root, profile, models);
  return { root, config: path.join(root, 'golem.yaml') };
}

test('model generation rejects an SDK manifest whose profile differs from the configured global profile', (t: TestContext) => {
  const root = createFixtureProject(t, 'runic-pipeline-profile-');

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  }));
  const source = path.join(root, 'src/cart.model.ts');
  fs.writeFileSync(source, [
    'type IModel<Fields extends object, Options = {}> = { fields: Fields; options: Options };',
    'export type TCart = IModel<{ note: string }>;',
    '',
  ].join('\n'));
  const manifest = path.join(root, 'sdk/model-manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({
    profile: { mobx: true, validation: true, ajvStandalone: false, allowAny: false },
    models: [],
  }));

  assert.throws(
    () => generateModels({
      root,
      sources: [source],
      profile: { mobx: false, validation: false },
      manifestInputs: [manifest],
    }),
    /profile mismatch/,
  );
  assert.equal(fs.existsSync(path.join(root, 'src/cart.model.generated.ts')), false);
});

test('a downstream model failure preserves the completed SDK and a later run repairs inventory', async (t: TestContext) => {
  const { root, config } = packageFixture(t);
  const source = path.join(root, 'src/cart.model.ts');
  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('note: string', 'note: any'));

  await assert.rejects(() => runPipeline(config), /contains any/);
  assert.equal(fs.existsSync(path.join(root, 'sdk/index.ts')), true);
  assert.equal(fs.existsSync(path.join(root, 'src/cart.model.generated.ts')), false);
  const interruptedInventory = JSON.parse(fs.readFileSync(path.join(root, '.golem/outputs.json'), 'utf8')) as {
    files: Record<string, unknown>;
  };
  assert.ok(Object.keys(interruptedInventory.files).some((filename) => filename === 'sdk/index.ts'));
  assert.equal(Object.keys(interruptedInventory.files).some((filename) => filename.startsWith('src/cart.model.generated')), false);

  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('note: any', 'note: string'));
  await runPipeline(config);
  assert.equal(fs.existsSync(path.join(root, 'src/cart.model.generated.ts')), true);
  await runPipeline(config, { check: true });
});

test('retiring an SDK job removes its unmodified outputs before the model consumer is analyzed', async (t: TestContext) => {
  const { root, config } = packageFixture(t);
  await runPipeline(config);
  assert.equal(fs.existsSync(path.join(root, 'sdk/index.ts')), true);

  fs.writeFileSync(config, [
    'version: 1',
    'mobx: false',
    'validation: true',
    'models:',
    '  root: .',
    '',
  ].join('\n'));
  await assert.rejects(
    () => runPipeline(config),
    /Cannot find module|cannot find module|TS2307|sdk[\\/]index/,
  );
  assert.equal(fs.existsSync(path.join(root, 'sdk/index.ts')), false);
  const inventory = JSON.parse(fs.readFileSync(path.join(root, '.golem/outputs.json'), 'utf8')) as {
    files: Record<string, unknown>;
  };
  assert.equal(Object.keys(inventory.files).some((filename) => filename.startsWith('sdk/')), false);
});

test('check reports stale outputs without changing generated files or inventory', async (t: TestContext) => {
  const { root, config } = packageFixture(t);
  await runPipeline(config);
  const source = path.join(root, 'src/cart.model.ts');
  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('note: string', 'note: string; selected?: boolean'));
  const before = snapshotFilesystem(root);

  await assert.rejects(() => runPipeline(config, { check: true }), /stale/);
  assert.deepEqual(snapshotFilesystem(root), before);
});
