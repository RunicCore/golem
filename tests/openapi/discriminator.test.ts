import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { getValidator } from '@exprtlabs/golem/validation';
import { createFixtureProject } from '../fixture-project.js';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  isGeneratedModelClass,
  requireRecord,
  type GeneratedModelClass,
  type OpenApiGenerationProfile,
} from './helpers.js';

interface PetShape {
  /** Union keyword carrying the discriminator. */
  readonly keyword?: 'oneOf' | 'anyOf';
  /** How the variant's own allOf part declares the tag, if at all. */
  readonly variantTag?: 'enum';
  /** The base declares no tag property; only the discriminator names it. */
  readonly baseWithoutTag?: boolean;
  /** The cat variant holds a nested discriminated union field. */
  readonly nestedToy?: boolean;
  /** The base declares the tag property without requiring it. */
  readonly optionalTag?: boolean;
  /** The union also admits null. */
  readonly nullBranch?: boolean;
}

/**
 * The standard OAS pattern: variants inherit an untyped string tag through
 * `allOf` and only the union's discriminator states which value selects them.
 * Every generated SDK in this process registers codecs by model name, so each
 * case uses its own component names.
 */
function petDocument(
  suffix: string,
  discriminator: Record<string, unknown> | undefined,
  shape: PetShape = {},
  catTag = 'cat',
  dogTag = 'dog',
): Record<string, unknown> {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}${suffix}` });
  const variant = (properties: Record<string, unknown>, required: string[], tag: string) => ({
    allOf: [ref('Base'), {
      type: 'object',
      required,
      properties: shape.variantTag === 'enum' ? { ...properties, kind: { type: 'string', enum: [tag] } } : properties,
    }],
  });
  const toys: Record<string, unknown> = shape.nestedToy ? {
    [`ToyBase${suffix}`]: { type: 'object', required: ['shape'], properties: { shape: { type: 'string' } } },
    [`ball${suffix}`]: { allOf: [ref('ToyBase'), { type: 'object', properties: { bounce: { type: 'boolean' } } }] },
    [`rope${suffix}`]: { allOf: [ref('ToyBase'), { type: 'object', properties: { length: { type: 'number' } } }] },
    [`Toy${suffix}`]: {
      oneOf: [ref('ball'), ref('rope')],
      discriminator: { propertyName: 'shape', mapping: { round: `#/components/schemas/ball${suffix}`, long: `#/components/schemas/rope${suffix}` } },
    },
  } : {};
  return {
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1' },
    paths: {},
    components: {
      schemas: {
        [`Base${suffix}`]: shape.baseWithoutTag
          ? { type: 'object', properties: { id: { type: 'string' } } }
          : { type: 'object', ...(shape.optionalTag ? {} : { required: ['kind'] }), properties: { kind: { type: 'string' } } },
        [`cat${suffix}`]: variant({
          name: { type: 'string' },
          ...(shape.nestedToy ? { toy: ref('Toy') } : {}),
        }, ['name'], catTag),
        [`dog${suffix}`]: variant({ bark: { type: 'boolean' } }, ['bark'], dogTag),
        [`Pet${suffix}`]: {
          [shape.keyword ?? 'oneOf']: [ref('cat'), ref('dog'), ...(shape.nullBranch ? [{ type: 'null' }] : [])],
          ...(discriminator ? { discriminator } : {}),
        },
        [`Owner${suffix}`]: {
          type: 'object',
          required: ['pet'],
          properties: { pet: ref('Pet'), pets: { type: 'array', items: ref('Pet') } },
        },
        ...toys,
      },
    },
  };
}

const explicitMapping = (suffix: string) => ({
  propertyName: 'kind',
  mapping: { feline: `#/components/schemas/cat${suffix}`, canine: `dog${suffix}` },
});

const cases: readonly {
  readonly name: string;
  readonly discriminator: (suffix: string) => Record<string, unknown>;
  readonly cat: (suffix: string) => readonly string[];
  readonly dog: (suffix: string) => string;
  readonly unknown: string;
  readonly shape?: PetShape;
  readonly warnings?: readonly string[];
}[] = [
  {
    name: 'explicit mapping with $ref and bare component name values',
    discriminator: explicitMapping,
    cat: () => ['feline'],
    dog: () => 'canine',
    unknown: 'cat',
  },
  {
    name: 'implicit mapping by raw component name',
    discriminator: () => ({ propertyName: 'kind' }),
    cat: suffix => [`cat${suffix}`],
    dog: suffix => `dog${suffix}`,
    unknown: 'Cat',
    warnings: ['OPENAPI_DISCRIMINATOR_IMPLICIT_VALUE', 'OPENAPI_DISCRIMINATOR_IMPLICIT_VALUE'],
  },
  {
    name: 'two mapping keys selecting one variant',
    discriminator: suffix => ({
      propertyName: 'kind',
      mapping: {
        cat: `#/components/schemas/cat${suffix}`,
        kitty: `#/components/schemas/cat${suffix}`,
        dog: `#/components/schemas/dog${suffix}`,
      },
    }),
    cat: () => ['cat', 'kitty'],
    dog: () => 'dog',
    unknown: 'bird',
  },
  {
    name: 'anyOf with explicit mapping',
    discriminator: explicitMapping,
    cat: () => ['feline'],
    dog: () => 'canine',
    unknown: 'bird',
    shape: { keyword: 'anyOf' },
  },
  {
    name: 'variant declares its tag as a single-value enum',
    discriminator: explicitMapping,
    cat: () => ['feline'],
    dog: () => 'canine',
    unknown: 'dog',
    shape: { variantTag: 'enum' },
  },
  {
    name: 'variants whose tag property is optional',
    discriminator: explicitMapping,
    cat: () => ['feline'],
    dog: () => 'canine',
    unknown: 'bird',
    shape: { optionalTag: true },
  },
  {
    name: 'variant with a nested discriminated union',
    discriminator: explicitMapping,
    cat: () => ['feline'],
    dog: () => 'canine',
    unknown: 'bird',
    shape: { nestedToy: true },
  },
  {
    name: 'union that also admits null',
    discriminator: explicitMapping,
    cat: () => ['feline'],
    dog: () => 'canine',
    unknown: 'bird',
    shape: { nullBranch: true },
  },
];

const profiles: readonly OpenApiGenerationProfile[] = [
  { mobx: false, validation: false },
  { mobx: true, validation: true },
];

function modelClass(exports: Record<string, unknown>, name: string): GeneratedModelClass {
  const value = exports[name];
  if (!isGeneratedModelClass(value)) throw new TypeError(`${name} must be a generated model class`);
  return value;
}

function codec(exports: Record<string, unknown>, name: string): (value: unknown) => unknown {
  const value = exports[name];
  if (typeof value !== 'function') throw new TypeError(`${name} must be a generated codec function`);
  return (input: unknown) => Reflect.apply(value, undefined, [input]);
}

test('OAS discriminator mappings select allOf variants in model decode, encode, and the shared codec', async suite => {
  for (const [caseIndex, example] of cases.entries()) {
    // Each case exercises a distinct lowering path; the second profile only re-runs the first case.
    for (const [profileIndex, profile] of (caseIndex === 0 ? profiles : profiles.slice(1)).entries()) {
      await suite.test(`${example.name} (mobx=${profile.mobx}, validation=${profile.validation})`, async t => {
        const suffix = `X${caseIndex}${profileIndex}`;
        const catTags = example.cat(suffix);
        const dogTag = example.dog(suffix);
        const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-'), 'sdk');
        const result = await generateMaterializedSdk(petDocument(suffix, example.discriminator(suffix), example.shape, catTags[0], dogTag), {
          output,
          name: 'Pets',
          profile: { mobx: profile.mobx, validation: profile.validation },
        });
        assert.deepEqual((result.diagnostics ?? []).map(diagnostic => diagnostic.code), example.warnings ?? []);
        compileGeneratedSdk(output, [], { strict: true });

        const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'pet models');
        // A union that admits null is not lowered to a model class of its own.
        const PetModel = example.shape?.nullBranch ? undefined : modelClass(models, `Pet${suffix}Model`);
        const CatModel = modelClass(models, `Cat${suffix}Model`);
        const DogModel = modelClass(models, `Dog${suffix}Model`);
        const OwnerModel = modelClass(models, `Owner${suffix}Model`);

        const toy = example.shape?.nestedToy ? { toy: { shape: 'round', bounce: true } } : {};
        if (PetModel) {
          for (const tag of catTags) {
            const pet: object = decodeGeneratedModel(PetModel, { kind: tag, name: 'Miso', ...toy });
            assert.ok(pet instanceof CatModel, `tag ${tag} selects cat`);
            assert.deepEqual(encodeGeneratedModel(pet), { kind: tag, name: 'Miso', ...toy });
            if (example.shape?.nestedToy) {
              const toyValue = requireRecord(pet, 'cat').toy;
              assert.ok(toyValue instanceof modelClass(models, `Ball${suffix}Model`), 'nested union selects its variant');
            }
          }
          const dog = decodeGeneratedModel(PetModel, { kind: dogTag, bark: true });
          assert.ok(dog instanceof DogModel, `tag ${dogTag} selects dog`);
          assert.deepEqual(encodeGeneratedModel(dog), { kind: dogTag, bark: true });
        }

        const ownerJson = {
          pet: { kind: dogTag, bark: false },
          pets: [...catTags.map(kind => ({ kind, name: 'Miso', ...toy })), { kind: dogTag, bark: true }],
        };
        const owner = requireRecord(decodeGeneratedModel(OwnerModel, ownerJson), 'owner');
        assert.ok(owner.pet instanceof DogModel);
        assert.ok(Array.isArray(owner.pets));
        assert.deepEqual(owner.pets.map(pet => pet instanceof CatModel), [...catTags.map(() => true), false]);
        assert.ok(owner.pets.at(-1) instanceof DogModel);
        assert.deepEqual(encodeGeneratedModel(owner), ownerJson);

        if (PetModel) {
          assert.throws(
            () => decodeGeneratedModel(PetModel, { kind: example.unknown, name: 'Miso' }),
            (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Deserialization,
          );
        }
        const decodeUnknownTag = () => decodeGeneratedModel(OwnerModel, { pet: { kind: example.unknown, name: 'Miso' } });
        if (example.shape?.nullBranch) assert.throws(decodeUnknownTag, (error: unknown) => error instanceof LibError);
        else assert.throws(decodeUnknownTag);

        if (example.shape?.nullBranch) {
          const nullableJson = { pet: null, pets: [{ kind: catTags[0], name: 'Miso' }, { kind: dogTag, bark: true }, null] };
          const nullable = requireRecord(decodeGeneratedModel(OwnerModel, nullableJson), 'nullable owner');
          assert.equal(nullable.pet, null);
          assert.ok(Array.isArray(nullable.pets));
          assert.ok(nullable.pets[0] instanceof CatModel && nullable.pets[1] instanceof DogModel);
          assert.equal(nullable.pets[2], null);
          assert.deepEqual(encodeGeneratedModel(nullable), nullableJson);
        }

        // The shared codec path (parse/stringify) dispatches on the same tags.
        const parsed = requireRecord(codec(models, `parseOwner${suffix}`)(JSON.stringify(ownerJson)), 'parsed owner');
        assert.ok(parsed.pet instanceof DogModel);
        assert.ok(Array.isArray(parsed.pets));
        assert.deepEqual(parsed.pets.map(pet => pet instanceof CatModel), [...catTags.map(() => true), false]);
        assert.deepEqual(JSON.parse(String(codec(models, `stringifyOwner${suffix}`)(owner))), ownerJson);
      });
    }
  }
});

test('a union variant used on its own keeps its declared tag type and any tag value', async t => {
  for (const validation of [false, true]) {
    const suffix = validation ? 'SoloV' : 'SoloN';
    const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-solo-'), 'sdk');
    await generateMaterializedSdk(petDocument(suffix, explicitMapping(suffix)), {
      output,
      name: 'Pets',
      profile: { mobx: false, validation },
    });
    const consumer = path.join(output, 'standalone-cat.ts');
    writeFileSync(consumer, [
      `import type { Cat${suffix}Init, Cat${suffix}Model } from './index.js';`,
      `export const init: Cat${suffix}Init = { kind: 'anything', name: 'Miso' };`,
      `export function kindOf(cat: Cat${suffix}Model): string { const kind: string = cat.kind; return kind; }`,
      '',
    ].join('\n'));
    compileGeneratedSdk(output, [consumer], { strict: true });
    const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'models');
    const CatModel = modelClass(models, `Cat${suffix}Model`);
    const parse = codec(models, `parseCat${suffix}`);
    const stringify = codec(models, `stringifyCat${suffix}`);
    // A tag the union never maps is still a valid standalone Cat.
    const other = { kind: 'other', name: 'Miso' };
    assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(CatModel, other)), other);
    assert.deepEqual(JSON.parse(String(stringify(parse(JSON.stringify(other))))), other);
    // A missing tag is left as is; only the base's `required` (validation) objects to it.
    const untagged = { name: 'Miso' };
    assert.deepEqual(encodeGeneratedModel(decodeGeneratedModel(CatModel, untagged)), untagged);
    if (validation) {
      // The variant's own validation schema is not narrowed to the union's tag.
      assert.equal(await getValidator(decodeGeneratedModel(CatModel, other)).validate(), true);
      assert.equal(await getValidator(decodeGeneratedModel(CatModel, untagged)).validate(), false, 'the base requires kind');
      assert.throws(
        () => parse(JSON.stringify(untagged)),
        (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation,
      );
    } else {
      assert.deepEqual(JSON.parse(String(stringify(parse(JSON.stringify(untagged))))), untagged);
    }
  }
});

test('one variant model can be selected by two discriminated unions, in either declaration order', async t => {
  const outcomes: unknown[] = [];
  // The lowering-order warning does not depend on the profile, so one profile (mobx and validation on) is enough.
  const profile = profiles[1];
  for (const order of ['union-first', 'shared-first'] as const) {
    const suffix = order === 'union-first' ? 'TwiceA' : 'TwiceB';
    const document = petDocument(suffix, explicitMapping(suffix));
    const schemas = requireRecord(requireRecord(document.components, 'components').schemas, 'schemas');
    const feline = {
      oneOf: [{ $ref: `#/components/schemas/cat${suffix}` }],
      discriminator: { propertyName: 'kind', mapping: { tabby: `#/components/schemas/cat${suffix}` } },
    };
    const ordered = order === 'union-first'
      ? { ...schemas, [`Feline${suffix}`]: feline }
      : { [`Feline${suffix}`]: feline, ...schemas };
    requireRecord(document.components, 'components').schemas = ordered;
    const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-twice-'), 'sdk');
    const result = await generateMaterializedSdk(document, { output, name: 'Pets', profile });
    assert.deepEqual(
      (result.diagnostics ?? []).map(diagnostic => diagnostic.code).sort(),
      ['OPENAPI_UNION_SHARED_VARIANT', 'OPENAPI_UNION_SHARED_VARIANT'],
    );
    compileGeneratedSdk(output, [], { strict: true });
    const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'models');
    const CatModel = modelClass(models, `Cat${suffix}Model`);
    const DogModel = modelClass(models, `Dog${suffix}Model`);
    const json = { pet: { kind: 'feline', name: 'Miso' }, pets: [{ kind: 'canine', bark: true }] };
    const owner = requireRecord(decodeGeneratedModel(modelClass(models, `Owner${suffix}Model`), json), 'owner');
    assert.ok(owner.pet instanceof CatModel);
    assert.ok(Array.isArray(owner.pets) && owner.pets[0] instanceof DogModel);
    assert.deepEqual(encodeGeneratedModel(owner), json);
    assert.throws(() => decodeGeneratedModel(modelClass(models, `Owner${suffix}Model`), { pet: { kind: 'tabby', name: 'Miso' } }));
    // Cat cannot extend both unions, so neither becomes a union model class.
    outcomes.push([`Pet${suffix}Model` in models, `Feline${suffix}Model` in models]);
  }
  assert.deepEqual(outcomes, [[false, false], [false, false]]);
});

test('a discriminator over a non-model variant is reported and left to the union shape', async t => {
  const suffix = 'Inline';
  const document = petDocument(suffix, undefined);
  const schemas = requireRecord(requireRecord(document.components, 'components').schemas, 'schemas');
  schemas[`Pet${suffix}`] = {
    oneOf: [
      { $ref: `#/components/schemas/cat${suffix}` },
      { type: 'object', required: ['kind'], properties: { kind: { const: 'stray' } } },
    ],
    discriminator: { propertyName: 'kind' },
  };
  delete schemas[`Owner${suffix}`];
  const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-inline-'), 'sdk');
  const result = await generateMaterializedSdk(document, { output, name: 'Pets', profile: { mobx: false, validation: false } });
  assert.deepEqual((result.diagnostics ?? []).map(diagnostic => diagnostic.code), ['OPENAPI_DISCRIMINATOR_NOT_LOWERED']);
  assert.match(result.diagnostics?.[0]?.message ?? '', /"PetInline"/);
});

test('a discriminator mapping must target one of the union variants', async t => {
  const suffix = 'Stray';
  const document = petDocument(suffix, {
    propertyName: 'kind',
    mapping: { feline: `#/components/schemas/cat${suffix}`, stray: `#/components/schemas/Owner${suffix}` },
  });
  const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-stray-'), 'sdk');
  await assert.rejects(
    () => generateMaterializedSdk(document, { output, name: 'Pets', profile: { mobx: false, validation: false } }),
    /discriminator mapping "stray" of schema "PetStray" \(openapi\.json#\/components\/schemas\/PetStray\) targets "#\/components\/schemas\/OwnerStray", which is not one of its variants/,
  );
});

test('every variant must declare the discriminator property', async t => {
  const suffix = 'Untagged';
  const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-untagged-'), 'sdk');
  await assert.rejects(
    () => generateMaterializedSdk(petDocument(suffix, explicitMapping(suffix), { baseWithoutTag: true }), {
      output,
      name: 'Pets',
      profile: { mobx: false, validation: false },
    }),
    /discriminator property "kind" of schema "PetUntagged" \(openapi\.json#\/components\/schemas\/PetUntagged\) is not declared by variant "catUntagged" \(openapi\.json#\/components\/schemas\/catUntagged\)/,
  );
});

test('a discriminator inherited through allOf without oneOf is reported as unsupported', async t => {
  const suffix = 'Inherited';
  const document = petDocument(suffix, undefined);
  const schemas = requireRecord(requireRecord(document.components, 'components').schemas, 'schemas');
  delete schemas[`Pet${suffix}`];
  delete schemas[`Owner${suffix}`];
  requireRecord(schemas[`Base${suffix}`], 'base').discriminator = { propertyName: 'kind' };
  const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-inherited-'), 'sdk');
  const result = await generateMaterializedSdk(document, { output, name: 'Pets', profile: { mobx: false, validation: false } });
  assert.deepEqual(
    (result.diagnostics ?? []).map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [['OPENAPI_DISCRIMINATOR_INHERITANCE_UNSUPPORTED', 'warning']],
  );
  assert.match(result.diagnostics?.[0]?.message ?? '', /"BaseInherited"/);
});

test('discriminator-less object unions name the schema and suggest a discriminator', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-undiscriminated-'), 'sdk');
  await assert.rejects(
    () => generateMaterializedSdk(petDocument('Plain', undefined), { output, name: 'Pets', profile: { mobx: false, validation: false } }),
    /schema "PetPlain".*discriminator/s,
  );
});

/** Two object variants that each hold a date-time, so the union needs a conversion and has no tag to pick a variant by. */
function untaggedVariants(): Record<string, unknown>[] {
  const born = { type: 'string', format: 'date-time' };
  const object = (properties: Record<string, unknown>) => ({ type: 'object', required: Object.keys(properties), properties });
  return [object({ name: { type: 'string' }, born }), object({ bark: { type: 'boolean' }, born })];
}

const untaggedUnions: readonly { readonly shape: string; readonly schemas: Record<string, unknown>; readonly error: RegExp }[] = [
  {
    shape: 'a field that refers to a component oneOf',
    schemas: { Pet: { oneOf: untaggedVariants() }, Owner: { type: 'object', properties: { pet: { $ref: '#/components/schemas/Pet' } } } },
    error: /schema "Owner"[^:]*: OPENAPI_UNION_DISCRIMINATOR_MISSING: Object union conversions require a unique, required literal discriminator\. The variants are \{ name, born \} \| \{ bark, born \}\. Give each variant a required const or enum tag/,
  },
  {
    shape: 'a field that holds an inline oneOf',
    schemas: { Owner: { type: 'object', properties: { pet: { oneOf: untaggedVariants() } } } },
    error: /schema "Owner"[^:]*: OPENAPI_UNION_DISCRIMINATOR_MISSING: Object union conversions require a unique, required literal discriminator\. The variants are \{ name, born \} \| \{ bark, born \}\. Give each variant a required const or enum tag/,
  },
];

for (const { shape, schemas, error } of untaggedUnions) {
  test(`${shape} with no literal tag stops generation with OPENAPI_UNION_DISCRIMINATOR_MISSING`, async t => {
    // protects: T-232 coded diagnostic for an untagged object union (golem-openapi path)
    for (const validation of [false, true]) {
      const output = path.join(createFixtureProject(t, 'golem-openapi-untagged-'), 'sdk');
      const document = { openapi: '3.1.0', info: { title: 'Untagged', version: '1' }, paths: {}, components: { schemas } };
      await assert.rejects(
        () => generateMaterializedSdk(document, { output, name: 'Untagged', profile: { mobx: false, validation } }),
        error,
        `validation=${validation}`,
      );
    }
  });
}
