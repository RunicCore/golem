import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { compositionProject as fixture } from './support/model-composition-project.js';
import { buildModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

// protects: T-552 a model narrows an inherited field to a model that extends it (golem-model's covariant override)
test('a model narrows an inherited model field to a model that extends it', async t => {
  const { root, sourceRoot } = fixture(t);
  writeModelSources(sourceRoot, {
    'pets.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
export type TPet = IModel<{ name: string }>;
export type TCat = IModel<TPet & { lives: number }>;
export type TBase = IModel<{ pet: TPet; pets: TPet[] }>;
export type TDerived = IModel<TBase & { pet: TCat; pets: TCat[] }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = await import(`${path.join(root, 'build/pets.model.generated.js')}?${Date.now()}`);
  const wire = { pet: { name: 'Tom', lives: 9 }, pets: [{ name: 'Kit', lives: 1 }] };
  const derived = decodeGeneratedModel(generated.TDerivedBaseModel, wire);
  assert.ok(derived.pet instanceof generated.TCatBaseModel);
  assert.deepEqual(encodeGeneratedModel(derived), wire);
});
