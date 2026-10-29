import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { generate } from '#model/generator';
import { copyFixtureFile, readFixture } from './fixture-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { requireRecord, type GeneratedModelClass } from './openapi/helpers.js';
import { loadPets } from './support/pets-project.js';
import { modelCodec } from './support/model-codec.js';

test('an IModel union variant tagged by several literal values is selected by each of them', async (t) => {
  for (const validation of [false, true]) {
    const { root } = createModelProject(t, { prefix: 'golem-union-multi-tag-', name: 'union-multi-tag' });
    copyFixtureFile(root, 'models/multi-tag/pets.model.ts', 'src/pets.model.ts');
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const { Owner, Cat, Dog } = await loadPets(root);
    const json = {
      pet: { kind: 'kitty', name: 'Miso' },
      pets: [{ kind: 'cat', name: 'Tama' }, { kind: 'kitty', name: 'Miso' }, { kind: 'dog', bark: false }],
    };
    const owner = requireRecord(modelCodec(Owner).fromWireFormat(json), 'owner');
    assert.ok(owner.pet instanceof Cat, `validation=${validation}: kitty selects Cat`);
    assert.ok(Array.isArray(owner.pets));
    assert.deepEqual(owner.pets.map(pet => pet instanceof Cat), [true, true, false]);
    assert.ok(owner.pets[2] instanceof Dog);
    assert.deepEqual(modelCodec(owner).toWireFormat(owner), json);
    assert.throws(() => modelCodec(Owner).fromWireFormat({ pet: { kind: 'bird', name: 'Miso' }, pets: [] }));
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
  for (const [fixture, message] of [
    ['pets', /Union in TOwner has 2 object variants \(\{ bark: boolean; born: Date; \} \| \{ name: string; born: Date; \}\) and does not declare its tag key\./],
    ['named-objects', /Union in TPets has 2 object variants \(TCat \| TDog\) and does not declare its tag key\./],
    ['models', /Union in TPets has 2 object variants \(Item0 \| Item1\) and does not declare its tag key\./],
  ] as const) {
    test(`an untagged union of ${fixture} stops generation with RUNM1080, its place and the tag to add, with validation ${validation ? 'on' : 'off'}`, t => {
      // protects: T-598 rule (a) the untagged object union names the Discriminator to add, whatever the variants are
      const { root, sourceRoot } = createModelProject(t, { prefix: `golem-untagged-${fixture}-`, name: `untagged-${fixture}` });
      writeFileSync(path.join(sourceRoot, 'pets.model.ts'), readFixture(`models/untagged-union/${fixture}.model.ts`));
      assert.throws(
        () => generate({ root, profile: { mobx: false, validation } }),
        error => error instanceof Error
          && /pets\.model\.ts:\d+:\d+ RUNM1080: /.test(error.message)
          && message.test(error.message)
          && error.message.includes("add `& Discriminator<'kind'>` to the union"),
      );
    });
  }
}

// Every position a union can stand in. `union` is the union as written there, with or without the tag.
const POSITIONS: readonly (readonly [place: string, field: (union: string) => string])[] = [
  ['a field', union => `value: ${union}`],
  ['an optional field', union => `value?: ${union}`],
  ['an array item', union => `value: (${union})[]`],
  ['a record value', union => `value: Record<string, ${union}>`],
  ['a tuple item', union => `value: [string, ${union}]`],
  ['a nested field', union => `value: { inner: ${union} }`],
  ['a nullable field', union => `value: ${union} | null`],
];

/** A model file with `field` in the model `TBox`; `variants` are the declarations of the union's members. */
function boxModel(variants: string, field: string): string {
  return `import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { Discriminator } from '@exprtlabs/golem/tags';

${variants}
export type TBox = IModel<{ ${field} }>;
`;
}

const PLAIN_VARIANTS = `export type TA = IObject<{ kind: 'a'; x: string }>;
export type TB = IObject<{ kind: 'b'; y: number }>;
`;

/** Generation of `source` as `pets.model.ts`: the error it throws, or undefined when it generates. */
function generationError(t: Parameters<typeof createModelProject>[0], source: string, validation: boolean): Error | undefined {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-union-place-', name: 'union-place' });
  writeFileSync(path.join(sourceRoot, 'pets.model.ts'), source);
  try {
    generate({ root, profile: { mobx: false, validation } });
    return undefined;
  } catch (thrown) {
    return thrown as Error;
  }
}

for (const validation of [false, true]) {
  for (const [place, field] of POSITIONS) {
    const suffix = `${place}, with validation ${validation ? 'on' : 'off'}`;
    test(`an untagged union of plain-data objects in ${suffix} stops with RUNM1080`, t => {
      // protects: T-598 rule (a) and (e) RUNM1080 at every position, also when no variant needs a conversion
      const error = generationError(t, boxModel(PLAIN_VARIANTS, field('TA | TB')), validation);
      assert.match(error?.message ?? '', /pets\.model\.ts:\d+:\d+ RUNM1080: Union in TBox has 2 object variants \(TA \| TB\) and does not declare its tag key\. .*add `& Discriminator<'kind'>` to the union\./);
    });

    test(`a tagged union of plain-data objects in ${suffix} generates`, t => {
      // protects: T-598 rule (d) and (e) the declared tag at every position needs no other tag
      assert.equal(generationError(t, boxModel(PLAIN_VARIANTS, field("(TA | TB) & Discriminator<'kind'>")), validation), undefined);
    });

    test(`a tagged union whose variant lacks the key in ${suffix} stops with RUNM1087`, t => {
      // protects: T-598 rule (b) a variant without the declared key stops at every position
      const variants = `export type TA = IObject<{ kind: 'a'; x: string }>;\nexport type TB = IObject<{ y: number }>;\n`;
      const error = generationError(t, boxModel(variants, field("(TA | TB) & Discriminator<'kind'>")), validation);
      assert.match(error?.message ?? '', /RUNM1087: Union variant TB in TBox has no required literal property "kind"/);
    });

    test(`a tagged union whose variants share a key value in ${suffix} stops with RUNM1087`, t => {
      // protects: T-598 rule (b) a shared tag value stops at every position
      const variants = `export type TA = IObject<{ kind: 'a'; x: string }>;\nexport type TB = IObject<{ kind: 'a'; y: number }>;\n`;
      const error = generationError(t, boxModel(variants, field("(TA | TB) & Discriminator<'kind'>")), validation);
      assert.match(error?.message ?? '', /RUNM1087: Union variants TA and TB in TBox share the "kind" value "a"/);
    });

    test(`one object beside a scalar and null in ${suffix} needs no tag`, t => {
      // protects: T-598 rule (c) a single object variant is no object union
      assert.equal(generationError(t, boxModel(PLAIN_VARIANTS, field('TA | string | null')), validation), undefined);
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

test('a Date beside an array converts by the wire form: a string is the Date, an array is the array', async (t) => {
  // protects: T-320 `Date | Date[]` once stopped generation with RUNM1082; the JSON string and the JSON array tell the two apart
  const day = '2024-05-06T07:08:09.000Z';
  const moment = new Date(day);
  const cases = [
    [{ at: day, from: day, maybe: day }, { at: moment, from: moment, maybe: moment }],
    [{ at: [day], from: ['a'], maybe: [day] }, { at: [moment], from: ['a'], maybe: [moment] }],
    [{ at: day, from: day, maybe: null }, { at: moment, from: moment, maybe: null }],
  ] as const;
  for (const validation of [false, true]) {
    const { root } = createModelProject(t, { prefix: 'golem-date-or-dates-', name: 'date-or-dates', linkWorkspaceNodeModules: true });
    copyFixtureFile(root, 'models/date-or-dates/when.model.ts', 'src/when.model.ts');
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const { When } = await import(pathToFileURL(path.join(root, 'build/when.model.js')).href) as { When: GeneratedModelClass };
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TWhen'));
    const options = { validate: validation };
    for (const [wire, value] of cases) {
      for (const decoded of [codec.fromWireFormat(wire, options), codec.parse(JSON.stringify(wire), options), modelCodec(When).fromWireFormat(wire)]) {
        assert.deepEqual({ ...requireRecord(decoded, 'decoded') }, value, `validation=${validation}`);
      }
      const model = new When(value as never);
      assert.deepEqual(codec.toWireFormat(model, options), wire, `validation=${validation}`);
      assert.deepEqual(modelCodec(model).toWireFormat(model), wire, `validation=${validation}`);
      assert.equal(codec.stringify(model, options), JSON.stringify(wire), `validation=${validation}`);
    }
  }
});

test('a number beside an array and null writes null as null in stringify, with validation on and off', async (t) => {
  // protects: T-604 a nullable scalar-or-array union stringified its single scalar with stringifyJsonNumber, which throws on null
  const cases = [{ v: 1 }, { v: [1, 2] }, { v: null }] as const;
  for (const validation of [false, true]) {
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-number-or-numbers-', name: 'number-or-numbers', linkWorkspaceNodeModules: true });
    writeFileSync(path.join(sourceRoot, 'amount.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TAmountBaseModel } from './amount.model.generated.js';
export type TAmount = IModel<{ v: number | number[] | null }>;
export class Amount extends TAmountBaseModel {}
`);
    writeModelGolemYaml(root, { mobx: false, validation });
    await buildModelProject(root);
    const { Amount } = await import(pathToFileURL(path.join(root, 'build/amount.model.js')).href) as { Amount: GeneratedModelClass };
    const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TAmount'));
    for (const wire of cases) {
      const model = new Amount(wire as never);
      assert.equal(codec.stringify(model, { validate: validation }), JSON.stringify(wire), `validation=${validation}`);
      assert.deepEqual(modelCodec(model).toWireFormat(model), wire, `validation=${validation}`);
    }
  }
});
