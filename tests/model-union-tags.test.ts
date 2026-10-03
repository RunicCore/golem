import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { generate } from '#model/generator';
import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { buildModelProject, createModelProject } from './model-project.js';
import { isGeneratedModelClass, requireRecord, type GeneratedModelClass } from './openapi/helpers.js';

test('an IModel union variant tagged by several literal values is selected by each of them', async (t) => {
  for (const validation of [false, true]) {
    const { root } = createModelProject(t, { prefix: 'golem-union-multi-tag-', name: 'union-multi-tag' });
    const source = copyFixtureFile(root, 'models/multi-tag/pets.model.ts', 'src/pets.model.ts');
    writeGeneratedArtifacts(generate({ root, sources: [source], profile: { mobx: false, validation } }).artifacts);
    await buildModelProject(root);
    const pets = {
      ...requireRecord(await import(pathToFileURL(path.join(root, 'build/pets.model.js')).href), 'pets module'),
      ...requireRecord(await import(pathToFileURL(path.join(root, 'build/pets.model.generated.js')).href), 'pets companion'),
    };
    const model = (name: string): GeneratedModelClass => {
      const value = pets[name];
      if (!isGeneratedModelClass(value)) throw new TypeError(`${name} must be a generated model class`);
      return value;
    };
    const [Owner, Cat, Dog] = [model('Owner'), model('TCatBaseModel'), model('TDogBaseModel')];
    const json = {
      pet: { kind: 'kitty', name: 'Miso' },
      pets: [{ kind: 'cat', name: 'Tama' }, { kind: 'kitty', name: 'Miso' }, { kind: 'dog', bark: false }],
    };
    const owner = requireRecord(decodeGeneratedModel(Owner, json), 'owner');
    assert.ok(owner.pet instanceof Cat, `validation=${validation}: kitty selects Cat`);
    assert.ok(Array.isArray(owner.pets));
    assert.deepEqual(owner.pets.map(pet => pet instanceof Cat), [true, true, false]);
    assert.ok(owner.pets[2] instanceof Dog);
    assert.deepEqual(encodeGeneratedModel(owner), json);
    assert.throws(() => decodeGeneratedModel(Owner, { pet: { kind: 'bird', name: 'Miso' }, pets: [] }));
  }
});

test('union members are emitted in canonical order whichever order the checker created their types in', t => {
  // Each model is generated alone, so its literal types are created in its own declaration order.
  // The checker orders a union by type creation, so only the analysis's own sort can make the two outputs agree.
  // (Models in one program share their literal types, so the checker orders their unions alike and no such pair could fail.)
  const fieldLines = (name: 'a' | 'b'): string[] => {
    const project = createModelProject(t, { prefix: `golem-union-order-${name}-`, name: `union-order-${name}` });
    for (const source of [`${name}.model.ts`, 'other.model.ts']) writeFileSync(path.join(project.sourceRoot, source), readFixture(`models/union-order/${source}`));
    const artifact = generate({ root: project.root, profile: { mobx: false, validation: true } }).artifacts
      .find(candidate => candidate.path.endsWith(`${name}.model.generated.ts`));
    assert.ok(artifact, `${name}.model.generated.ts must be generated`);
    // Every generated type alias that mentions a field, with the alias name normalised (codec-id lines carry hashes and are excluded).
    return artifact.content.split('\n')
      .filter(line => /^(export )?type \w+ = /.test(line) && /\b(priority|mixed|link)\b/.test(line))
      .map(line => line.replace(/\bT[AB](?![a-z])/g, 'T')); // TA, TAJSON, TABaseModel -> T, TJSON, TBaseModel
  };
  const fromA = fieldLines('a');
  assert.ok(fromA.length > 0, 'generated type aliases must mention the union fields');
  assert.ok(fromA.some(line => /\blink\b/.test(line)), 'the model-reference union must be among the compared aliases');
  assert.deepEqual(fromA, fieldLines('b'));
});
