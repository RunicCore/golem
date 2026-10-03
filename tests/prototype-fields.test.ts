import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { getValidator } from '@exprtlabs/golem/validation';
import { generate } from '#model/generator';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelSources } from './model-project.js';
import { prototypeFieldsModelSource } from './fixture-templates/models/prototype-fields.js';

// One run keeps mobx and the other keeps validation; the other two profile
// combinations add no generated init path for dictionary keys.
const profiles = [
  { mobx: false, validation: false },
  { mobx: true, validation: true },
] as const;

for (const { mobx, validation } of profiles) {
  test(`dictionary data keys survive generation (mobx=${mobx}, validation=${validation})`, async (t) => {
    const { root, sourceRoot } = createModelProject(t, {
      prefix: 'golem-model-prototype-',
      name: 'model-prototype',
      linkWorkspaceNodeModules: true,
    });
    writeModelSources(sourceRoot, { 'item.model.ts': prototypeFieldsModelSource({ mobx }) });
    const result = generate({ root, profile: { mobx, validation } });
    writeGeneratedArtifacts(result.artifacts);
    const companion = result.artifacts.find((item) => item.path.endsWith('/item.model.generated.ts'))?.content ?? '';
    assert.match(companion, /defineModelProperty/);
    await buildModelProject(root);
    const { Item } = await import(`${pathToFileURL(path.join(root, 'build/item.model.js')).href}?${mobx}-${validation}`);
    const values = Object.fromEntries([
      ['label', 'own'],
      ['dictionary', Object.fromEntries([['__proto__', 'dictionary-own']])],
      ['nested', { value: 7 }],
    ]);
    const model = new Item(values);
    assert.equal(Object.hasOwn(model, 'label'), true);
    assert.equal(model.label, 'own');
    assert.equal(Object.hasOwn(model.dictionary, '__proto__'), true);
    assert.equal(model.dictionary['__proto__'], 'dictionary-own');
    assert.equal(Object.hasOwn(model.nested, 'value'), true);
    assert.equal(model.nested.value, 7);
    assert.equal(Object.getPrototypeOf(model), Item.prototype);
    if (mobx) {
      const { isObservableProp } = await import('mobx');
      assert.equal(isObservableProp(model, 'label'), true);
    }

    const decoded = decodeGeneratedModel(Item, values);
    assert.equal(Object.hasOwn(decoded, 'label'), true);
    assert.equal(decoded.label, 'own');
    assert.equal(Object.hasOwn(decoded.dictionary, '__proto__'), true);
    assert.equal(Object.hasOwn(decoded.nested, 'value'), true);
    const encoded = encodeGeneratedModel(model) as Record<string, unknown>;
    assert.equal(Object.hasOwn(encoded, 'label'), true);
    assert.equal(encoded.label, 'own');
    assert.equal(Object.hasOwn(encoded.dictionary as object, '__proto__'), true);
    assert.equal(Object.hasOwn(encoded.nested as object, 'value'), true);
    if (validation) {
      const invalid = new Item(JSON.parse('{"label":99,"dictionary":{"__proto__":"dictionary-own"},"nested":{"value":7}}') as Record<string, unknown>);
      assert.equal(await getValidator(invalid).validate(), false);
      assert.deepEqual(getValidator(invalid).issues[0]?.path, ['label']);
    }
  });
}
