import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { generate } from '#model/generator';
import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { compileModelProject, createModelProject } from './model-project.js';
import { isGeneratedModelClass, requireRecord, type GeneratedModelClass } from './openapi/helpers.js';

test('an IModel union variant tagged by several literal values is selected by each of them', async (t) => {
  for (const validation of [false, true]) {
    const { root } = createModelProject(t, { prefix: 'golem-union-multi-tag-', name: 'union-multi-tag' });
    const source = copyFixtureFile(root, 'models/multi-tag/pets.model.ts', 'src/pets.model.ts');
    writeGeneratedArtifacts(generate({ root, sources: [source], profile: { mobx: false, validation } }).artifacts);
    await compileModelProject(root);
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

test('union members are emitted in canonical order regardless of declaration order', t => {
  const project = createModelProject(t, { prefix: 'golem-union-order-', name: 'union-order' });
  for (const name of ['a.model.ts', 'b.model.ts']) {
    writeFileSync(path.join(project.sourceRoot, name), readFixture(`models/union-order/${name}`));
  }
  const result = generate({ root: project.root, profile: { mobx: false, validation: true } });
  const text = (file: string): string => {
    const artifact = result.artifacts.find(candidate => candidate.path.endsWith(file));
    assert.ok(artifact, `${file} must be generated`);
    return artifact.content;
  };
  // Every generated type alias that mentions a field, with the alias name normalised (codec-id lines carry hashes and are excluded).
  const fieldLines = (file: string): string[] => text(file).split('\n')
    .filter(line => /^(export )?type \w+ = /.test(line) && /\b(priority|mixed)\b/.test(line))
    .map(line => line.replace(/\bT[AB](?![a-z])/g, 'T')); // TA, TAJSON, TABaseModel -> T, TJSON, TBaseModel
  const fromA = fieldLines('a.model.generated.ts');
  assert.ok(fromA.length > 0, 'generated type aliases must mention the union fields');
  assert.deepEqual(fromA, fieldLines('b.model.generated.ts'));
});
