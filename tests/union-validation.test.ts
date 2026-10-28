import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { getValidator } from '@exprtlabs/golem/validation';
import { copyFixtureFile } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { requireRecord } from './openapi/helpers.js';
import { loadPets } from './support/pets-project.js';

import { schemaForDescriptor } from '@exprtlabs/golem/internal/schema';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { registerIModelClass } from '@exprtlabs/golem/serde';
import type { ModelTypeDescriptor, ModelTypeMetadata } from '@exprtlabs/golem/model';
import { installCodecModel } from './register-codec-model.js';
import { compileSchema } from './support/compiled-validators.js';

async function discriminatedFixture() {
  const calls = { a: 0, b: 0 };
  const branch = (kind: 'a' | 'b', validation: 'a' | 'b'): ModelTypeDescriptor => ({
    kind: 'object',
    properties: {
      value: { kind: 'number', validations: [validation] },
      kind: { kind: 'literal', value: kind },
    },
    required: ['value', 'kind'],
    additionalProperties: false,
  });
  const shape: ModelTypeDescriptor = {
    kind: 'union',
    variants: [branch('a', 'a'), branch('b', 'b')],
  };

  class ShapeModel {
    public constructor(public kind: 'a' | 'b', public value: unknown) {}
  }
  await installCodecModel({
    constructor: ShapeModel,
    name: 'Shape',
    fields: ['kind', 'value'],
    bindings: {
      a: (value: unknown): boolean | string => {
        calls.a++;
        return value === 1 || 'A values must equal one';
      },
      b: (value: unknown): boolean | string => {
        calls.b++;
        return value === 2 || 'B values must equal two';
      },
    },
    conversion: {
      decode: (value) => Object.assign(new ShapeModel('a', 0), value as object),
      encode: (model) => ({ kind: model.kind, value: model.value }),
    },
    definitions: { Shape: shape },
  });

  return { calls, ShapeModel };
}

test('discriminated unions do not invoke predicates from another branch', async () => {
  const { calls, ShapeModel } = await discriminatedFixture();
  const validB = new ShapeModel('b', 2);
  const validator = getValidator(validB);

  assert.equal(await validator.validate(), true);
  assert.deepEqual(calls, { a: 0, b: 1 }, 'only the selected branch predicate may run');
});

test('discriminated unions retain selected-branch nested predicate paths', async () => {
  const { calls, ShapeModel } = await discriminatedFixture();
  const invalidB = new ShapeModel('b', 3);
  const validator = getValidator(invalidB);

  assert.equal(await validator.validate(), false);
  assert.ok(validator.issues.some((issue) => issue.path[0] === 'value'));
  assert.deepEqual(calls, { a: 0, b: 1 }, 'the unselected branch predicate must stay unused');
});

async function taggedUnionFixture(name: string, variants: readonly ModelTypeDescriptor[]) {
  class TaggedModel {
    public constructor(wire: Record<string, unknown>) {
      Object.assign(this, wire);
    }
  }
  await installCodecModel({
    constructor: TaggedModel,
    name,
    fields: ['tag', 'value'],
    bindings: {
      positiveValue: (value: unknown): boolean | string =>
        (typeof value === 'object' && value !== null && Number(Reflect.get(value, 'value')) > 0) || 'value must be positive',
      knownTag: (value: unknown): boolean | string => value === 'b' || 'tag must be b',
    },
    definitions: { [name]: { kind: 'union', variants: [...variants] } },
  });
  return async (wire: Record<string, unknown>): Promise<boolean> => {
    return getValidator(new TaggedModel(wire)).validate();
  };
}

function taggedBranch(tag: ModelTypeDescriptor, metadata: ModelTypeMetadata = {}): ModelTypeDescriptor {
  return {
    kind: 'object',
    properties: { tag, value: { kind: 'number' } },
    required: ['tag', 'value'],
    additionalProperties: false,
    ...metadata,
  };
}

for (const [label, tags] of [
  ['numeric', [1, 2]],
  ['boolean', [true, false]],
  ['empty-string', ['', 'x']],
] as const) {
  test(`object unions tagged by ${label} literals install and validate`, async () => {
    const validate = await taggedUnionFixture(`Tagged_${label.replace('-', '_')}`, tags.map((value) => taggedBranch({ kind: 'literal', value })));
    assert.equal(await validate({ tag: tags[0], value: 1 }), true);
    assert.equal(await validate({ tag: tags[1], value: 1 }), true);
    assert.equal(await validate({ tag: tags[0], value: 'no' }), false);
    assert.equal(await validate({ tag: 'other', value: 1 }), false);
  });
}

test('string-tagged unions install when a variant or its tag carries validations', async () => {
  const validate = await taggedUnionFixture('TaggedWrapped', [
    taggedBranch({ kind: 'literal', value: 'a' }, { validations: ['positiveValue'] }),
    taggedBranch({ kind: 'literal', value: 'b', validations: ['knownTag'] }),
    taggedBranch({ kind: 'literal', value: 'c' }, { constraints: [{ kind: 'minProperties', value: 2 }] }),
  ]);
  assert.equal(await validate({ tag: 'a', value: 1 }), true);
  assert.equal(await validate({ tag: 'a', value: -1 }), false);
  assert.equal(await validate({ tag: 'b', value: -1 }), true);
  assert.equal(await validate({ tag: 'c', value: -1 }), true);
  assert.equal(await validate({ tag: 'd', value: 1 }), false);
});

test('only unions tagged by required non-empty string consts use the discriminator', async () => {
  const union = (...tags: (string | number)[]): ModelTypeDescriptor => ({
    kind: 'union',
    variants: tags.map((value) => taggedBranch({ kind: 'literal', value })),
  });
  const stringTagged = schemaForDescriptor(union('a', 'b'));
  assert.ok(typeof stringTagged === 'object');
  assert.deepEqual(stringTagged.discriminator, { propertyName: 'tag' });
  assert.ok(Array.isArray(stringTagged.oneOf));
  const numberTagged = schemaForDescriptor(union(1, 2));
  assert.ok(typeof numberTagged === 'object');
  assert.equal(numberTagged.discriminator, undefined);
  assert.ok(Array.isArray(numberTagged.anyOf));
});

test('a union of references to models of this job uses the discriminator of their string tags, and an OpenAPI document maps each tag', () => {
  const definitions = { A: taggedBranch({ kind: 'literal', value: 'a' }), B: taggedBranch({ kind: 'literal', value: 'b' }), N: taggedBranch({ kind: 'literal', value: 1 }) };
  const union = (...variants: ModelTypeDescriptor[]): ModelTypeDescriptor => ({ kind: 'union', variants });
  const reference = (name: string): ModelTypeDescriptor => ({ kind: 'reference', name });
  const forms = (schema: ReturnType<typeof schemaForDescriptor>) => (typeof schema === 'object' ? { discriminator: schema.discriminator, oneOf: schema.oneOf, anyOf: schema.anyOf } : schema);
  assert.deepEqual(forms(schemaForDescriptor(union(reference('A'), reference('B')), { definitions })), {
    discriminator: { propertyName: 'tag' }, oneOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }], anyOf: undefined,
  });
  assert.deepEqual(forms(schemaForDescriptor(union(reference('A'), reference('B')), { definitions, referencePrefix: '#/components/schemas/', discriminatorMapping: true })), {
    discriminator: { propertyName: 'tag', mapping: { a: '#/components/schemas/A', b: '#/components/schemas/B' } },
    oneOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }],
    anyOf: undefined,
  });
  // A number tag, a target with its own serde, an inline object beside a reference, and a generated model of another job keep anyOf.
  assert.deepEqual(forms(schemaForDescriptor(union(reference('A'), reference('N')), { definitions })), {
    discriminator: undefined, oneOf: undefined, anyOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/N' }],
  });
  const withSerde = { ...definitions, S: { ...taggedBranch({ kind: 'literal', value: 's' }), serde: { id: 'shape', wire: { kind: 'string' } } } satisfies ModelTypeDescriptor };
  assert.deepEqual(forms(schemaForDescriptor(union(reference('A'), reference('S')), { definitions: withSerde })), {
    discriminator: undefined, oneOf: undefined, anyOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/S' }],
  });
  const mixed = forms(schemaForDescriptor(union(reference('A'), taggedBranch({ kind: 'literal', value: 'b' })), { definitions }));
  assert.ok(typeof mixed === 'object' && mixed.discriminator === undefined && Array.isArray(mixed.anyOf) && mixed.anyOf.length === 2);
  assert.deepEqual(forms(schemaForDescriptor(union(reference('A'), { kind: 'generated-model', id: 'other/B' }), { definitions })), {
    discriminator: undefined, oneOf: undefined, anyOf: [{ $ref: '#/$defs/A' }, { $ref: '__exprtGeneratedModel:B' }],
  });
});

test('the full validator of a reference union reports a wrong tag at the tag, and a bad field of a known tag at that field', async () => {
  const definitions = { A: taggedBranch({ kind: 'literal', value: 'a' }), B: taggedBranch({ kind: 'literal', value: 'b' }) };
  const references: ModelTypeDescriptor = { kind: 'union', variants: [{ kind: 'reference', name: 'A' }, { kind: 'reference', name: 'B' }] };
  const schema = schemaForDescriptor(references, { definitions });
  assert.ok(typeof schema === 'object');
  const validate = await compileSchema({ $id: 'ReferenceUnion', ...schema });
  assert.deepEqual(validate({ tag: 'c', value: 1 }, true), [{ path: ['tag'], code: 'literal', expected: ['a', 'b'] }]);
  assert.deepEqual(validate({ tag: 'a', value: 'x' }, true), [{ path: ['value'], code: 'type', expected: ['number'] }]);
});

test('an explicit tag table validates each variant against its own tag values', async () => {
  const variant = (properties: Record<string, ModelTypeDescriptor>): ModelTypeDescriptor => ({
    kind: 'object',
    properties: { kind: { kind: 'string' }, ...properties },
    required: ['kind', ...Object.keys(properties)],
    additionalProperties: false,
  });
  const pet: ModelTypeDescriptor = {
    kind: 'union',
    variants: [{ kind: 'reference', name: 'TableCat' }, { kind: 'reference', name: 'TableDog' }],
    discriminator: { propertyName: 'kind', variants: [{ values: ['cat', 'kitty'] }, { values: ['dog'] }] },
  };
  const definitions = { TablePet: pet, TableCat: variant({ name: { kind: 'string' } }), TableDog: variant({ bark: { kind: 'boolean' } }) };
  const wireSchema = schemaForDescriptor(pet, { definitions, representation: 'wire' });
  assert.ok(typeof wireSchema === 'object');
  assert.deepEqual(wireSchema.discriminator, { propertyName: 'kind' }, 'string wire tags keep the discriminator');
  const modelSchema = schemaForDescriptor(pet, { definitions, representation: 'model' });
  assert.ok(typeof modelSchema === 'object');
  assert.equal(modelSchema.discriminator, undefined, 'a model instance need not carry an undeclared tag');
  class TablePetModel {
    public constructor(wire: Record<string, unknown>) {
      Object.assign(this, wire);
    }
  }
  await installCodecModel({ constructor: TablePetModel, name: 'TablePet', fields: ['kind', 'name', 'bark'], definitions });
  const validate = (wire: Record<string, unknown>) => getValidator(new TablePetModel(wire)).validate();
  assert.equal(await validate({ kind: 'kitty', name: 'Miso' }), true);
  assert.equal(await validate({ kind: 'cat', name: 'Miso' }), true);
  assert.equal(await validate({ kind: 'dog', bark: true }), true);
  assert.equal(await validate({ kind: 'dog', name: 'Miso' }), false, 'a dog tag selects the dog variant only');
  assert.equal(await validate({ kind: 'bird', name: 'Miso' }), false);

  const validateWire = await compileSchema({ $id: 'TablePetWire', ...wireSchema });
  const wireIssues = (wire: unknown): number => validateWire(wire, false).length;
  assert.equal(wireIssues({ kind: 'kitty', name: 'Miso' }), 0);
  assert.equal(wireIssues({ kind: 'dog', name: 'Miso' }), 1, 'the wire dog tag with cat fields is invalid');
  assert.equal(wireIssues({ kind: 'bird', name: 'Miso' }), 1);
  assert.equal(wireIssues({ name: 'Miso' }), 1, 'the wire tag is required');
});

test('model-plane validation selects the variant class the encoder selects', async () => {
  const open = (properties: Record<string, ModelTypeDescriptor>): ModelTypeDescriptor => ({
    kind: 'object', properties, required: Object.keys(properties), additionalProperties: true,
  });
  const definitions: Record<string, ModelTypeDescriptor> = {
    UntaggedOwner: {
      kind: 'object',
      properties: {
        pet: {
          kind: 'union',
          variants: [{ kind: 'reference', name: 'UntaggedCat' }, { kind: 'reference', name: 'UntaggedDog' }],
          discriminator: { propertyName: 'kind', variants: [{ values: ['cat'] }, { values: ['dog'] }] },
        },
      },
      required: ['pet'],
      additionalProperties: false,
    },
    UntaggedCat: open({ name: { kind: 'string' } }),
    UntaggedDog: open({ bark: { kind: 'boolean' } }),
  };
  class UntaggedOwnerModel {
    public constructor(public pet: unknown) {}
  }
  class CatInstance {
    public name = 'Miso';
    public bark = true;
  }
  class DogInstance extends CatInstance {}
  class Stranger {
    public name = 'Miso';
  }
  // The codec encoder selects the most-derived registered variant class of an instance.
  registerIModelClass('UntaggedCat', CatInstance);
  registerIModelClass('UntaggedDog', DogInstance);
  await installCodecModel({ constructor: UntaggedOwnerModel, name: 'UntaggedOwner', fields: ['pet'], definitions });
  const validate = (pet: unknown) => getValidator(new UntaggedOwnerModel(pet)).validate();
  assert.equal(await validate(new CatInstance()), true, 'an untagged instance encodes with its canonical tag');
  assert.equal(await validate(new DogInstance()), true, 'a subclass instance selects its own variant');
  assert.equal(await validate({ kind: 'cat', name: 'Miso' }), true);
  assert.equal(await validate(Object.assign(new CatInstance(), { kind: 'cat' })), true);
  assert.equal(await validate({ name: 'Miso' }), false, 'a plain object without the tag cannot be encoded');
  assert.equal(await validate(new Stranger()), false, 'an unrelated class instance without the tag cannot be encoded');
  assert.equal(await validate(Object.assign(new Date(0), { name: 'Miso' })), false);
  assert.equal(await validate(Object.assign(new CatInstance(), { kind: 'bird' })), false);
  assert.equal(await validate(Object.assign(new CatInstance(), { kind: 'dog' })), false, 'a Cat instance with a Dog tag');
  assert.equal(await validate(Object.assign(new DogInstance(), { kind: 'cat' })), false, 'a Dog instance with a Cat tag');
});

test('IModel object unions with validation load, validate and reject an unknown tag', async (t) => {
  const { root } = createModelProject(t, { prefix: 'golem-union-validation-', name: 'union-validation' });
  copyFixtureFile(root, 'models/union-validation/pets.model.ts', 'src/pets.model.ts');
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  // Without the build-time rewrite, nested values construct the generated bases.
  const { Owner, Cat, Dog } = await loadPets(root);
  const json = { pet: { kind: 'dog', bark: true }, pets: [{ kind: 'cat', name: 'Miso' }, { kind: 'dog', bark: false }] };
  const owner = decodeGeneratedModel(Owner, json);
  const fields = requireRecord(owner, 'owner');
  assert.ok(fields.pet instanceof Dog);
  assert.ok(Array.isArray(fields.pets) && fields.pets[0] instanceof Cat);
  assert.deepEqual(encodeGeneratedModel(owner), json);
  assert.equal(await getValidator(owner).validate(), true);
  assert.throws(
    () => decodeGeneratedModel(Owner, { pet: { kind: 'bird', name: 'Miso' }, pets: [] }),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Deserialization
      && /Unknown kind discriminator value: "bird"/.test(error.message),
  );
});
