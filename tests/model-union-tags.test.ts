import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { generate } from '#model/generator';
import { copyFixtureFile, readFixture } from './fixture-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { isGeneratedModelClass, requireRecord, type GeneratedModelClass } from './openapi/helpers.js';

test('an IModel union variant tagged by several literal values is selected by each of them', async (t) => {
  for (const validation of [false, true]) {
    const { root } = createModelProject(t, { prefix: 'golem-union-multi-tag-', name: 'union-multi-tag' });
    copyFixtureFile(root, 'models/multi-tag/pets.model.ts', 'src/pets.model.ts');
    writeModelGolemYaml(root, { mobx: false, validation });
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

for (const validation of [false, true]) {
  test(`an object union with no literal tag stops generation with RUNM1080, the model file and the fix, with validation ${validation ? 'on' : 'off'}`, t => {
    // protects: T-232 coded diagnostic for an untagged object union (golem-model path)
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-untagged-union-', name: 'untagged-union' });
    writeFileSync(path.join(sourceRoot, 'pets.model.ts'), readFixture('models/untagged-union/pets.model.ts'));
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation } }),
      /pets\.model\.ts RUNM1080: Object union conversions require a unique, required literal discriminator\. The variants are \{ bark, born \} \| \{ name, born \}\. Give each variant a required literal tag, such as `kind: 'cat'`/,
    );
  });
}

for (const validation of [false, true]) {
  for (const [fixture, variants] of [
    ['named-objects', /The variants are TCat \| TDog\./],
    ['models', /The variants are Item0 \| Item1\./],
  ] as const) {
    test(`two ${fixture} with no literal tag stop generation with RUNM1080, the model file and the variants, with validation ${validation ? 'on' : 'off'}`, t => {
      // protects: T-309 coded diagnostic for a union of named objects or models with no tag
      const { root, sourceRoot } = createModelProject(t, { prefix: `golem-untagged-${fixture}-`, name: `untagged-${fixture}` });
      writeFileSync(path.join(sourceRoot, 'pets.model.ts'), readFixture(`models/untagged-union/${fixture}.model.ts`));
      assert.throws(
        () => generate({ root, profile: { mobx: false, validation } }),
        error => error instanceof Error
          && /pets\.model\.ts RUNM1080: Object union conversions require a unique, required literal discriminator\. The variants are /.test(error.message)
          && variants.test(error.message),
      );
    });
  }
}

test('a union whose scalar variants cannot be told apart stops generation with RUNM1082 and the model file', t => {
  // protects: T-309 coded diagnostic for an ambiguous scalar union
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-ambiguous-scalars-', name: 'ambiguous-scalars' });
  writeFileSync(path.join(sourceRoot, 'when.model.ts'), readFixture('models/untagged-union/scalars.model.ts'));
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /when\.model\.ts RUNM1082: Union has ambiguous conversions\. Use a discriminated object union or one serde pair for the value\. The variants are /,
  );
});

test('a Date beside an array of Date, or beside an array of strings, converts by the wire form: a string is the Date, an array is the array', async (t) => {
  // protects: T-320 `Date | Date[]` once stopped generation with RUNM1082; the JSON string and the JSON array tell the two apart
  for (const validation of [false, true]) {
    const { root } = createModelProject(t, { prefix: 'golem-date-or-dates-', name: 'date-or-dates', linkWorkspaceNodeModules: true });
    copyFixtureFile(root, 'models/date-or-dates/when.model.ts', 'src/when.model.ts');
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const { When } = await import(pathToFileURL(path.join(root, 'build/when.model.js')).href) as { When: GeneratedModelClass };
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TWhen'));
    const options = { validate: validation };
    const day = '2024-05-06T07:08:09.000Z';
    const moment = new Date(day);
    const scalarWire = { at: day, from: day, maybe: day };
    const arrayWire = { at: [day, day], from: ['a', 'b'], maybe: [day] };
    const scalar = { at: moment, from: moment, maybe: moment };
    const array = { at: [moment, moment], from: ['a', 'b'], maybe: [moment] };
    const label = `validation=${validation}`;

    for (const decoded of [codec.fromWireFormat(scalarWire, options), codec.parse(JSON.stringify(scalarWire), options), decodeGeneratedModel(When, scalarWire)]) {
      assert.deepEqual({ ...requireRecord(decoded, 'decoded') }, scalar, label);
    }
    for (const decoded of [codec.fromWireFormat(arrayWire, options), codec.parse(JSON.stringify(arrayWire), options), decodeGeneratedModel(When, arrayWire)]) {
      assert.deepEqual({ ...requireRecord(decoded, 'decoded') }, array, label);
    }
    const nullWire = { at: day, from: day, maybe: null };
    assert.deepEqual(codec.fromWireFormat(nullWire, options), { at: moment, from: moment, maybe: null }, label);
    assert.throws(() => codec.fromWireFormat({ at: [day, 'not a date'], from: day }, options), label);

    assert.deepEqual(codec.toWireFormat(new When(scalar as never), options), scalarWire, label);
    assert.deepEqual(codec.toWireFormat(new When(array as never), options), arrayWire, label);
    assert.deepEqual(encodeGeneratedModel(new When(scalar as never)), scalarWire, label);
    assert.deepEqual(encodeGeneratedModel(new When(array as never)), arrayWire, label);
    assert.equal(codec.stringify(new When(scalar as never), options), JSON.stringify(scalarWire), label);
    assert.equal(codec.stringify(new When(array as never), options), JSON.stringify(arrayWire), label);
    assert.deepEqual(codec.toWireFormat(new When({ at: moment, from: moment, maybe: null } as never), options), nullWire, label);
    assert.equal(codec.stringify(new When({ at: moment, from: moment, maybe: null } as never), options), JSON.stringify(nullWire), label);
  }
});
