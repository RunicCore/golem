import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { compositionProject as fixture } from './support/model-composition-project.js';
import { buildModelProject, writeModelGolemYaml } from './model-project.js';
import { discardedProjectionCodecsSource, discardedProjectionMetadataSource } from './fixture-templates/models/model-composition.js';
import { generate } from '#model/generator';

test('an unrelated same-name class does not become a model constructor', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/an-unrelated-same-name-class-does-not-become-a-model-constructor/item.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = await import(`${path.join(root, 'build/item.model.generated.js')}?${Date.now()}`);
  const authored = await import(`${path.join(root, 'build/item.model.js')}?${Date.now()}`);
  const parent = new generated.TParentBaseModel({ child: { id: 'child' } });
  assert.ok(parent.child instanceof generated.TItemBaseModel);
  assert.equal(parent.child instanceof authored.Item, false);
  assert.deepEqual(encodeGeneratedModel(parent), { child: { id: 'child' } });
});

test('first generation resolves model class bases through project path aliases', async t => {
  const { root, sourceRoot } = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', imports: { '#generated/*': './build/*.model.generated.js' } }));
  config.compilerOptions.paths = { '#generated/*': ['./src/*.model.generated.ts'] };
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases/item.model.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'parent.model.ts'), readFixture("models/model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases/parent.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = await import(`${path.join(root, 'build/parent.model.generated.js')}?${Date.now()}`);
  const authored = await import(path.join(root, 'build/item.model.js'));
  const parent = new generated.TParentBaseModel({ child: { id: 'nested' } });
  assert.ok(parent.child instanceof authored.Item);
  assert.equal(parent.child.label, 'nested');
  assert.deepEqual(encodeGeneratedModel(parent), { child: { id: 'nested' } });
});


test('IModel exposes fields and rejects root unions before emitting artifacts', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'keys.ts'), readFixture("models/model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts/keys.ts"));
  await buildModelProject(root);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts/item.model.ts"));
  for (const validation of [true, false]) {
    assert.throws(() => generate({ root, profile: { mobx: false, validation } }), /RUNM1052.*Root IModel unions/);
  }
  assert.equal(fs.existsSync(path.join(sourceRoot, 'item.model.generated.ts')), false);
});

test('generated readonly fields remain readonly to TypeScript consumers', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/generated-readonly-fields-remain-readonly-to-typescript-consumers/item.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  fs.writeFileSync(path.join(sourceRoot, 'readonly-consumer.ts'), readFixture("models/model-composition/generated-readonly-fields-remain-readonly-to-typescript-consumers/readonly-consumer.ts"));
  await buildModelProject(root);
});

test('anonymous nested IModel declarations fail with an actionable diagnostic', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/anonymous-nested-imodel-declarations-fail-with-an-actionable-diagnostic/item.model.ts"));
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /RUNM1053.*named, exported declaration/,
  );
});

for (const tag of ['serde', 'validation'] as const) {
  test(`projection rejects discarded whole-object ${tag} metadata`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), discardedProjectionCodecsSource({ metadata: tag }).text);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), discardedProjectionMetadataSource({ metadata: tag }).text);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation: true } }),
      /RUNM1055.*whole-object constraints or serialization/,
    );
  });
}

test('generic model templates require a concrete named declaration', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/generic-model-templates-require-a-concrete-named-declaration/item.model.ts"));
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /RUNM1057.*concrete fields/);
});

for (const ajvStandalone of [false, true]) {
  test(`MobX projections retain nested observability with standalone=${ajvStandalone}`, async t => {
    const { root, sourceRoot } = fixture(t, ajvStandalone);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/model-composition-item-model/item.model.ts"));
    writeModelGolemYaml(root, { mobx: true, validation: true, ajvStandalone });
    await buildModelProject(root);
    const { Parent, Child } = await import(path.join(root, 'build/item.model.js'));
    const { autorun, isObservableObject, runInAction } = await import('mobx');
    const parent = decodeGeneratedModel(Parent, { projected: { child: { name: 'First' } } });
    assert.ok(parent.projected.child instanceof Child);
    assert.equal(Object.getPrototypeOf(parent.projected), Object.prototype);
    assert.ok(isObservableObject(parent.projected.child));
    const seen: string[] = [];
    const dispose = autorun(() => { seen.push(parent.projected.child.name); });
    try {
      runInAction(() => { parent.projected.child.name = 'Next'; });
      assert.deepEqual(seen, ['First', 'Next']);
      assert.deepEqual(encodeGeneratedModel(parent), { projected: { child: { name: 'Next' } } });
      runInAction(() => { parent.projected.child.name = 'x'; });
      assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'Parent')).assert( encodeGeneratedModel(parent)));
    } finally { dispose(); }
  });
}
