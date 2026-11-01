import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { createFixtureProject } from '../fixture-project.js';
import {
  compileGeneratedSdk,
  generateMaterializedSdk,
  requireRecord,
  sdkBodyCodec,
  withRootOperations,
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
    [`ball${suffix}`]: { allOf: [ref('ToyBase'), { type: 'object', properties: { bounce: { type: 'boolean' }, made: { type: 'string', format: 'date-time' } } }] },
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
          born: { type: 'string', format: 'date-time' },
          ...(shape.nestedToy ? { toy: ref('Toy') } : {}),
        }, ['name'], catTag),
        [`dog${suffix}`]: variant({ bark: { type: 'boolean' }, adopted: { type: 'string', format: 'date-time' } }, ['bark'], dogTag),
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
    // protects: I-58 a value names its component unless a mapping entry has that value, so a mapped variant keeps its component name
    name: 'a mapped variant also takes its component name as a value',
    discriminator: explicitMapping,
    cat: suffix => ['feline', `cat${suffix}`],
    dog: () => 'canine',
    unknown: 'bird',
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
  { validation: false },
  { mobx: true, validation: true },
];

const BORN = '2024-05-06T07:08:09.000Z';
const ADOPTED = '2025-01-02T03:04:05.000Z';

/** Generates the pets SDK of `document` with a body reached for each root in `roots`, and returns the codec of each root. */
async function generatePets(
  t: Parameters<typeof createFixtureProject>[0],
  document: Record<string, unknown>,
  roots: readonly string[],
  profile: OpenApiGenerationProfile,
  extraFiles: string[] = [],
): Promise<{ output: string; diagnostics: readonly { code: string }[]; codec: (root: string) => ReturnType<typeof sdkBodyCodec> }> {
  const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-'), 'sdk');
  const result = await generateMaterializedSdk(withRootOperations(document, ...roots), { output, name: 'Pets', profile });
  compileGeneratedSdk(output, extraFiles, { strict: true });
  return { output, diagnostics: result.diagnostics ?? [], codec: root => sdkBodyCodec(output, 'Pets', root) };
}

const isLibError = (error: unknown): boolean => error instanceof LibError;
/** The per-call option that turns the checks off; a tag value only the decoder accepts (a component name) then passes. */
const unchecked = { validate: false };

test('OAS discriminator mappings select allOf variants in decode and encode', async suite => {
  for (const [caseIndex, example] of cases.entries()) {
    // Each case exercises a distinct lowering path; the second profile only re-runs the first case.
    for (const [profileIndex, profile] of (caseIndex === 0 ? profiles : profiles.slice(1)).entries()) {
      await suite.test(`${example.name} (mobx=${profile.mobx}, validation=${profile.validation})`, async t => {
        const suffix = `X${caseIndex}${profileIndex}`;
        const catTags = example.cat(suffix);
        const dogTag = example.dog(suffix);
        const pets = await generatePets(
          t,
          petDocument(suffix, example.discriminator(suffix), example.shape, catTags[0], dogTag),
          [`Owner${suffix}`, `Pet${suffix}`],
          { mobx: profile.mobx, validation: profile.validation },
        );
        assert.deepEqual(pets.diagnostics.map(diagnostic => diagnostic.code), example.warnings ?? []);

        // A tag selects its variant when only that variant's date field converts.
        const toyWire = example.shape?.nestedToy ? { toy: { shape: 'round', bounce: true, made: BORN } } : {};
        const toyValue = example.shape?.nestedToy ? { toy: { shape: 'round', bounce: true, made: new Date(BORN) } } : {};
        const catWire = (kind: string) => ({ kind, name: 'Miso', born: BORN, ...toyWire });
        const catValue = (kind: string) => ({ kind, name: 'Miso', born: new Date(BORN), ...toyValue });
        const dogWire = { kind: dogTag, bark: true, adopted: ADOPTED };
        const dogValue = { kind: dogTag, bark: true, adopted: new Date(ADOPTED) };

        const pet = await pets.codec(`Pet${suffix}`);
        for (const tag of catTags) {
          assert.deepEqual(await pet.decode(catWire(tag), unchecked), catValue(tag), `tag ${tag} selects cat`);
          assert.deepEqual(await pet.encode(catValue(tag), unchecked), catWire(tag));
        }
        assert.deepEqual(await pet.decode(dogWire, unchecked), dogValue, `tag ${dogTag} selects dog`);
        assert.deepEqual(await pet.encode(dogValue, unchecked), dogWire);
        await assert.rejects(() => pet.decode({ kind: example.unknown, name: 'Miso' }, unchecked), isLibError);

        const owner = await pets.codec(`Owner${suffix}`);
        const ownerWire = { pet: dogWire, pets: [...catTags.map(tag => catWire(tag)), dogWire] };
        const ownerValue = { pet: dogValue, pets: [...catTags.map(tag => catValue(tag)), dogValue] };
        assert.deepEqual(await owner.decode(ownerWire, unchecked), ownerValue);
        assert.deepEqual(await owner.encode(ownerValue, unchecked), ownerWire);
        await assert.rejects(() => owner.decode({ pet: { kind: example.unknown, name: 'Miso' } }, unchecked), isLibError);
      });
    }
  }
});

test('a union that admits null decodes and encodes null beside its variants', async t => {
  const suffix = 'Nullable';
  const pets = await generatePets(t, petDocument(suffix, explicitMapping(suffix), { nullBranch: true }), [`Owner${suffix}`], profiles[1]);
  const owner = await pets.codec(`Owner${suffix}`);
  const wire = { pet: null, pets: [{ kind: 'feline', name: 'Miso', born: BORN }, { kind: 'canine', bark: true, adopted: ADOPTED }, null] };
  const value = { pet: null, pets: [{ kind: 'feline', name: 'Miso', born: new Date(BORN) }, { kind: 'canine', bark: true, adopted: new Date(ADOPTED) }, null] };
  assert.deepEqual(await owner.decode(wire), value);
  assert.deepEqual(await owner.encode(value), wire);
});

test('a union variant used on its own keeps its declared tag type and any tag value', async t => {
  for (const validation of [false, true]) {
    const suffix = validation ? 'SoloV' : 'SoloN';
    const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-solo-'), 'sdk');
    await generateMaterializedSdk(withRootOperations(petDocument(suffix, explicitMapping(suffix)), `cat${suffix}`), { output, name: 'Pets', profile: { validation } });
    const consumer = path.join(output, 'standalone-cat.ts');
    writeFileSync(consumer, [
      `import type { Cat${suffix} } from './types.js';`,
      `export const init: Cat${suffix} = { kind: 'anything', name: 'Miso' };`,
      `export function kindOf(cat: Cat${suffix}): string { const kind: string = cat.kind; return kind; }`,
      '',
    ].join('\n'));
    compileGeneratedSdk(output, [consumer], { strict: true });
    const cat = await sdkBodyCodec(output, 'Pets', `cat${suffix}`);
    // A tag the union never maps is still a valid standalone Cat.
    assert.deepEqual(await cat.decode({ kind: 'other', name: 'Miso', born: BORN }), { kind: 'other', name: 'Miso', born: new Date(BORN) });
    assert.deepEqual(await cat.encode({ kind: 'other', name: 'Miso', born: new Date(BORN) }), { kind: 'other', name: 'Miso', born: BORN });
  }
});

test('a standalone variant without its tag is rejected by the base only when validation is on', async t => {
  const untagged = { name: 'Miso' };
  const off = await generatePets(t, petDocument('SoloOff', explicitMapping('SoloOff')), ['catSoloOff'], { validation: false });
  assert.deepEqual(await (await off.codec('catSoloOff')).decode(untagged), untagged);
  const on = await generatePets(t, petDocument('SoloOn', explicitMapping('SoloOn')), ['catSoloOn'], { validation: true });
  await assert.rejects(
    async () => (await on.codec('catSoloOn')).decode(untagged),
    (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Validation,
  );
});

test('a variant shared by two discriminated unions is selected by each union through its own tags, in either declaration order', async t => {
  // protects: T-385 a shared variant is still selected by each union that lists it
  // The lowering order does not depend on the profile, so one profile (mobx and validation on) is enough.
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
    const pets = await generatePets(t, document, [`Pet${suffix}`, `Feline${suffix}`, `Owner${suffix}`], profiles[1]);
    assert.deepEqual(pets.diagnostics.map(diagnostic => diagnostic.code), []);

    const pet = await pets.codec(`Pet${suffix}`);
    const felineCodec = await pets.codec(`Feline${suffix}`);
    assert.deepEqual(await pet.decode({ kind: 'feline', name: 'Miso', born: BORN }), { kind: 'feline', name: 'Miso', born: new Date(BORN) });
    assert.deepEqual(await pet.decode({ kind: 'canine', bark: true, adopted: ADOPTED }), { kind: 'canine', bark: true, adopted: new Date(ADOPTED) });
    assert.deepEqual(await felineCodec.decode({ kind: 'tabby', name: 'Miso', born: BORN }), { kind: 'tabby', name: 'Miso', born: new Date(BORN) });
    assert.deepEqual(await felineCodec.encode({ kind: 'tabby', name: 'Miso', born: new Date(BORN) }), { kind: 'tabby', name: 'Miso', born: BORN });
    // A tag that another union maps is not one of this union's.
    await assert.rejects(() => felineCodec.decode({ kind: 'feline', name: 'Miso', born: BORN }), isLibError);
    await assert.rejects(() => pet.decode({ kind: 'tabby', name: 'Miso', born: BORN }), isLibError);
    const owner = await pets.codec(`Owner${suffix}`);
    const json = { pet: { kind: 'feline', name: 'Miso', born: BORN }, pets: [{ kind: 'canine', bark: true, adopted: ADOPTED }] };
    assert.deepEqual(await owner.encode(await owner.decode(json)), json);
  }
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
  const result = await generateMaterializedSdk(document, { output, name: 'Pets', profile: { validation: false } });
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
    () => generateMaterializedSdk(document, { output, name: 'Pets', profile: { validation: false } }),
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
      profile: { validation: false },
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
  const result = await generateMaterializedSdk(document, { output, name: 'Pets', profile: { validation: false } });
  assert.deepEqual(
    (result.diagnostics ?? []).map(diagnostic => [diagnostic.code, diagnostic.severity]),
    [['OPENAPI_DISCRIMINATOR_INHERITANCE_UNSUPPORTED', 'warning']],
  );
  assert.match(result.diagnostics?.[0]?.message ?? '', /"BaseInherited"/);
});

test('discriminator-less object unions name the schema and suggest a discriminator', async t => {
  const output = path.join(createFixtureProject(t, 'golem-openapi-undiscriminated-'), 'sdk');
  await assert.rejects(
    () => generateMaterializedSdk(petDocument('Plain', undefined), { output, name: 'Pets', profile: { validation: false } }),
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
  for (const validation of [false, true]) {
    test(`${shape} with no literal tag stops generation with OPENAPI_UNION_DISCRIMINATOR_MISSING, with validation ${validation ? 'on' : 'off'}`, async t => {
      // protects: T-232 coded diagnostic for an untagged object union (golem-openapi-ts path)
      const output = path.join(createFixtureProject(t, 'golem-openapi-untagged-'), 'sdk');
      const document = { openapi: '3.1.0', info: { title: 'Untagged', version: '1' }, paths: {}, components: { schemas } };
      await assert.rejects(
        () => generateMaterializedSdk(document, { output, name: 'Untagged', profile: { validation } }),
        error,
      );
    });
  }
}

for (const [form, defaultMapping] of [['a component name', 'Other'], ['a $ref', '#/components/schemas/Other']] as const) {
  test(`a 3.2 discriminator defaultMapping as ${form} selects the variant that has no tag, in decode and encode`, async t => {
    // protects: T-604 golem-openapi-ts reads discriminator.defaultMapping; the default variant may lack the tag property
    const suffix = form === 'a $ref' ? 'DefRef' : 'DefName';
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}${suffix}` });
    const stamp = (name: string) => ({ [name]: { type: 'string', format: 'date-time' } });
    const document = {
      openapi: '3.2.0',
      info: { title: 'Payments', version: '1' },
      paths: {},
      components: {
        schemas: {
          [`Card${suffix}`]: { type: 'object', required: ['kind', 'number'], properties: { kind: { type: 'string' }, number: { type: 'string' }, ...stamp('cardAt') } },
          [`Cash${suffix}`]: { type: 'object', required: ['kind', 'amount'], properties: { kind: { type: 'string' }, amount: { type: 'number' }, ...stamp('cashAt') } },
          [`Other${suffix}`]: { type: 'object', required: ['note'], properties: { note: { type: 'string' }, ...stamp('otherAt') } },
          [`Payment${suffix}`]: {
            oneOf: [ref('Card'), ref('Cash'), ref('Other')],
            discriminator: {
              propertyName: 'kind',
              mapping: { card: `#/components/schemas/Card${suffix}`, cash: `Cash${suffix}` },
              defaultMapping: `${defaultMapping}${suffix}`,
            },
          },
          [`Owner${suffix}`]: { type: 'object', required: ['payment'], properties: { payment: ref('Payment') } },
        },
      },
    };
    const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-default-'), 'sdk');
    await generateMaterializedSdk(withRootOperations(document, `Owner${suffix}`), { output, name: 'Payments', profile: { validation: true } });
    compileGeneratedSdk(output, [], { strict: true });
    const owner = await sdkBodyCodec(output, 'Payments', `Owner${suffix}`);
    const at = '2026-01-02T03:04:05.000Z';
    const date = new Date(at);
    const rows = [
      { wire: { kind: 'card', number: '1', cardAt: at }, value: { kind: 'card', number: '1', cardAt: date } },
      { wire: { kind: 'cash', amount: 2, cashAt: at }, value: { kind: 'cash', amount: 2, cashAt: date } },
      { wire: { note: 'n', otherAt: at }, value: { note: 'n', otherAt: date } },
      { wire: { kind: 'wire', note: 'n', otherAt: at }, value: { kind: 'wire', note: 'n', otherAt: date } },
    ];
    assert.deepEqual(await owner.decode({ payment: rows[0]!.wire }), { payment: rows[0]!.value });
    assert.deepEqual(await owner.decode({ payment: rows[1]!.wire }), { payment: rows[1]!.value });
    assert.deepEqual(await owner.decode({ payment: rows[2]!.wire }), { payment: rows[2]!.value });
    assert.deepEqual(await owner.decode({ payment: rows[3]!.wire }), { payment: rows[3]!.value });
    assert.deepEqual(await owner.encode({ payment: rows[2]!.value }), { payment: rows[2]!.wire });
  });
}

// The Discriminator Object (OpenAPI 3.1 and 3.2): a value names its component "unless a mapping is present for that value".
// A mapping key equal to a component name therefore removes that component's implicit value, whatever the key targets.
for (const [name, version, defaultMapping, suffix] of [
  ['a mapping key that names one variant and targets another', '3.1.0', undefined, 'KeyElsewhere'],
  ['a mapping key that names one variant and targets the default', '3.2.0', 'Other', 'KeyToDefault'],
] as const) {
  test(`${name} removes the implicit value of the variant it names`, async t => {
    // protects: discriminator value rule, a mapping for a value replaces the component-name value (3.1.1, 3.2.0)
    const ref = (component: string) => ({ $ref: `#/components/schemas/${component}${suffix}` });
    const tagged = (own: Record<string, unknown>) => ({
      type: 'object',
      required: ['kind', ...Object.keys(own)],
      properties: { kind: { type: 'string' }, ...own },
    });
    const document = {
      openapi: version,
      info: { title: 'Pets', version: '1' },
      paths: {},
      components: {
        schemas: {
          [`Cat${suffix}`]: tagged({ name: { type: 'string' } }),
          [`Dog${suffix}`]: tagged({ bark: { type: 'boolean' } }),
          [`Other${suffix}`]: { type: 'object', required: ['note'], properties: { note: { type: 'string' } } },
          [`Pet${suffix}`]: {
            oneOf: [ref('Cat'), defaultMapping ? ref('Other') : ref('Dog')],
            discriminator: {
              propertyName: 'kind',
              mapping: { [`Cat${suffix}`]: `${defaultMapping ?? 'Dog'}${suffix}` },
              ...(defaultMapping ? { defaultMapping: `${defaultMapping}${suffix}` } : {}),
            },
          },
          [`Owner${suffix}`]: { type: 'object', required: ['pet'], properties: { pet: ref('Pet') } },
        },
      },
    };
    const output = path.join(createFixtureProject(t, 'golem-openapi-discriminator-key-'), 'sdk');
    // Cat has no value of its own, so nothing selects it: generation stops and names the key, its target and the fix.
    await assert.rejects(
      generateMaterializedSdk(document, { output, name: 'Pets', profile: { validation: true } }),
      new RegExp(`OPENAPI_DISCRIMINATOR_VARIANT_UNSELECTED: .*Cat${suffix}.*the mapping key "Cat${suffix}" sends that value to .*${defaultMapping ?? 'Dog'}${suffix}.*mapping value of its own, or remove`),
    );
  });
}

test('a variant given a mapping value of its own is selected by it while the key that names it goes elsewhere', async t => {
  // protects: discriminator value rule (3.1.1, 3.2.0) a mapping for a value replaces the component-name value; the variant keeps the value it is given
  const tagged = (own: Record<string, unknown>) => ({ type: 'object', required: ['kind', ...Object.keys(own)], properties: { kind: { type: 'string' }, ...own } });
  const document = {
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1' },
    paths: {},
    components: {
      schemas: {
        CatOwn: tagged({ born: { type: 'string', format: 'date-time' } }),
        DogOwn: tagged({ adopted: { type: 'string', format: 'date-time' } }),
        PetOwn: {
          oneOf: [{ $ref: '#/components/schemas/CatOwn' }, { $ref: '#/components/schemas/DogOwn' }],
          discriminator: { propertyName: 'kind', mapping: { CatOwn: '#/components/schemas/DogOwn', feline: '#/components/schemas/CatOwn' } },
        },
        OwnerOwn: { type: 'object', required: ['pet'], properties: { pet: { $ref: '#/components/schemas/PetOwn' } } },
      },
    },
  };
  const pets = await generatePets(t, document, ['OwnerOwn'], { validation: true });
  const owner = await pets.codec('OwnerOwn');
  assert.deepEqual(await owner.decode({ pet: { kind: 'feline', born: BORN } }), { pet: { kind: 'feline', born: new Date(BORN) } });
  assert.deepEqual(await owner.decode({ pet: { kind: 'CatOwn', adopted: ADOPTED } }), { pet: { kind: 'CatOwn', adopted: new Date(ADOPTED) } });
});

test('a default variant that extends a tagged variant is chosen for an unmapped tag', async t => {
  // protects: T-605 a default that extends a tagged variant still takes an unmapped tag, which is not rejected
  const document = {
    openapi: '3.2.0',
    info: { title: 'Pets', version: '1' },
    paths: {},
    components: {
      schemas: {
        CatBase: { type: 'object', required: ['kind', 'name'], properties: { kind: { type: 'string' }, name: { type: 'string' } } },
        DogBase: { allOf: [{ $ref: '#/components/schemas/CatBase' }, { type: 'object', required: ['bark'], properties: { bark: { type: 'boolean' }, adopted: { type: 'string', format: 'date-time' } } }] },
        PetBase: {
          oneOf: [{ $ref: '#/components/schemas/CatBase' }, { $ref: '#/components/schemas/DogBase' }],
          discriminator: { propertyName: 'kind', mapping: { cat: '#/components/schemas/CatBase' }, defaultMapping: '#/components/schemas/DogBase' },
        },
        OwnerBase: { type: 'object', required: ['pet'], properties: { pet: { $ref: '#/components/schemas/PetBase' } } },
      },
    },
  };
  const pets = await generatePets(t, document, ['OwnerBase'], { validation: false });
  const owner = await pets.codec('OwnerBase');
  const wire = { pet: { kind: 'zzz', name: 'Rex', bark: true, adopted: ADOPTED } };
  const value = { pet: { kind: 'zzz', name: 'Rex', bark: true, adopted: new Date(ADOPTED) } };
  assert.deepEqual(await owner.decode(wire), value);
  assert.deepEqual(await owner.encode(value), wire);
});

for (const validation of [false, true]) {
  test(`a oneOf with no discriminator keyword takes a model with no tag as the default of its tagged objects, with validation ${validation ? 'on' : 'off'}`, async t => {
    // protects: T-602 golem-openapi-ts keeps a no-discriminator oneOf of one untagged model beside tagged objects: the model takes every other object
    const stamp = { type: 'string', format: 'date-time' };
    const document = {
      openapi: '3.1.0',
      info: { title: 'Payments', version: '1' },
      paths: {},
      components: {
        schemas: {
          MoneyUntagged: { type: 'object', required: ['amount', 'issued'], properties: { amount: { type: 'number' }, issued: stamp } },
          PayoutUntagged: {
            oneOf: [
              { $ref: '#/components/schemas/MoneyUntagged' },
              { type: 'object', required: ['kind', 'issued'], properties: { kind: { const: 'other' }, issued: stamp } },
            ],
          },
          OwnerUntagged: { type: 'object', required: ['payout'], properties: { payout: { $ref: '#/components/schemas/PayoutUntagged' } } },
        },
      },
    };
    const pets = await generatePets(t, document, ['OwnerUntagged'], { validation });
    const owner = await pets.codec('OwnerUntagged');
    const issued = '2026-01-02T03:04:05.000Z';
    const money = { payout: { amount: 3, issued } };
    const other = { payout: { kind: 'other', issued } };
    assert.deepEqual(await owner.decode(money), { payout: { amount: 3, issued: new Date(issued) } });
    assert.deepEqual(await owner.decode(other), { payout: { kind: 'other', issued: new Date(issued) } });
    assert.deepEqual(await owner.encode({ payout: { amount: 3, issued: new Date(issued) } }), money);
    assert.deepEqual(await owner.encode({ payout: { kind: 'other', issued: new Date(issued) } }), other);
  });
}
