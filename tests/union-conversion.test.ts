import assert from 'node:assert/strict';
import test from 'node:test';

import * as modelRuntime from '@exprtlabs/golem/internal/model-runtime';
import { bindInput, emitModelFromInit, emitModelFromJSON, inputOf, inputSlot, code, identifier, literal, type Code } from '@exprtlabs/golem/internal/emitter';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { DiscriminatorValue, ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { instantiateRuntime, type RuntimeFunction, emitCodecRuntimeText, renderWithHelpers } from './emitted-runtime.js';
import { runModule } from './support/run-module.js';

function failsWith(kind: LibErrorKind, message: RegExp): (error: unknown) => boolean {
  return (error) => error instanceof LibError && error.kind === kind && message.test(error.message);
}

function variant(properties: Record<string, ModelTypeDescriptor>): ModelTypeDescriptor {
  return { kind: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/** Owner.pet is `Cat | Dog | null`; the table maps tags onto Cat and Dog. */
function ownerRuntime(
  prefix: string,
  tags: readonly (readonly DiscriminatorValue[])[],
  options: {
    readonly taggedVariants: boolean;
    /** Classes the codec constructs for its own variant nodes, as OpenAPI models are. */
    readonly constructed?: Readonly<Record<string, unknown>>;
  },
) {
  const tag: Record<string, ModelTypeDescriptor> = options.taggedVariants ? { kind: { kind: 'string' } } : {};
  const graph = createSchemaGraph();
  graph.intern(variant({ ...tag, name: { kind: 'string' } }), `${prefix}Cat`, options.constructed !== undefined);
  graph.intern(variant({ ...tag, bark: { kind: 'boolean' } }), `${prefix}Dog`, options.constructed !== undefined);
  graph.intern(variant({
    pet: {
      kind: 'union',
      variants: [
        ...(['Cat', 'Dog'] as const).map((name): ModelTypeDescriptor => options.constructed
          ? { kind: 'reference', name: `${prefix}${name}`, construct: true }
          : { kind: 'generated-model', id: `${prefix}${name}` }),
        { kind: 'null' },
      ],
      discriminator: { propertyName: 'kind', variants: [{ values: tags[0] }, { values: tags[1] }, { values: [] }] },
    },
  }), `${prefix}Owner`);
  graph.seal();
  const classes = options.constructed ?? {};
  const source = emitCodecRuntimeText(graph, {
    validationLevel: false,
    ...(options.constructed
      ? { nestedConstruct: (codecId: string) => identifier(`${prefix}${codecId.startsWith(`${prefix}Cat`) ? 'Cat' : 'Dog'}Model`) }
      : {}),
  });
  const runtime = instantiateRuntime(source, {
    ...classes,
    // Test classes are not registered generated models; convert them directly.
    decodeGeneratedModelTrusted: (constructor: new () => object, value: object) =>
      value instanceof constructor ? value : Object.assign(new constructor(), value),
  });
  return {
    stringify: (value: unknown) => runtime[`stringify${prefix}Owner`](value),
    parse: (text: string) => runtime[`parse${prefix}Owner`](text) as { pet: unknown },
    toWire: (value: unknown) => runtime[`toWireFormat${prefix}Owner`](value) as { pet: unknown },
  };
}

test('shared codec rejects an unknown or missing tag on encode and decode, and writes/reads null only for null', () => {
  const owner = ownerRuntime('Unknown', [['cat', 'kitty'], ['dog']], { taggedVariants: true });
  for (const pet of [{ kind: 'bird', name: 'Miso' }, { name: 'Miso' }]) {
    assert.throws(() => owner.stringify({ pet }), failsWith(LibErrorKind.Serialization, /discriminator value/), 'stringify');
    assert.throws(() => owner.toWire({ pet }), failsWith(LibErrorKind.Serialization, /discriminator value/), 'toWireFormat');
  }
  assert.throws(
    () => owner.parse('{"pet":{"kind":"bird","name":"Miso"}}'),
    // Codec fill functions run outside a field conversion scope, so the path is the tag alone.
    failsWith(LibErrorKind.Deserialization, /Unknown kind discriminator value: "bird"/),
    'parse',
  );
  assert.equal(owner.stringify({ pet: null }), '{"pet":null}');
  assert.deepEqual(owner.toWire({ pet: null }), { pet: null });
  assert.equal(owner.parse('{"pet":null}').pet, null, 'a non-object value is left to validation');
  for (const pet of [{ kind: 'cat', name: 'Miso' }, { kind: 'kitty', name: 'Miso' }, { kind: 'dog', bark: true }]) {
    const text = owner.stringify({ pet });
    assert.equal(text, JSON.stringify({ pet }));
    assert.deepEqual(owner.parse(text).pet, pet);
  }
});

test('shared codec selects constructed reference variants by class, like model conversion', () => {
  class ConstructedCatModel {
    public constructor(values: object = {}) {
      Object.assign(this, values);
    }
  }
  class ConstructedDogModel extends ConstructedCatModel {}
  const owner = ownerRuntime('Constructed', [['cat', 'kitty'], ['dog']], {
    taggedVariants: false,
    constructed: { ConstructedCatModel, ConstructedDogModel },
  });
  const cat = new ConstructedCatModel({ name: 'Miso' });
  assert.deepEqual(owner.toWire({ pet: cat }), { pet: { name: 'Miso', kind: 'cat' } }, 'an untagged instance writes the canonical tag');
  const text = owner.stringify({ pet: cat });
  assert.equal(text, '{"pet":{"kind":"cat","name":"Miso"}}');
  assert.ok(owner.parse(text).pet instanceof ConstructedCatModel);
  assert.ok(!(owner.parse(text).pet instanceof ConstructedDogModel));
  const dog = new ConstructedDogModel({ bark: true });
  assert.equal(owner.stringify({ pet: dog }), '{"pet":{"kind":"dog","bark":true}}', 'a subclass selects its own variant');
  const foreign = new ConstructedCatModel({ kind: 'dog', name: 'Miso', bark: true });
  assert.throws(() => owner.toWire({ pet: foreign }), failsWith(LibErrorKind.Serialization, /"dog"/), 'a Cat instance with a Dog tag');
  assert.throws(() => owner.stringify({ pet: foreign }), failsWith(LibErrorKind.Serialization, /"dog"/));
});

test('number and boolean table tags select variants through the shared codec', () => {
  const owner = ownerRuntime('Scalar', [[1], [true]], { taggedVariants: false });
  assert.deepEqual(owner.parse('{"pet":{"kind":true,"bark":false}}').pet, { bark: false });
  assert.deepEqual(owner.parse('{"pet":{"kind":1,"name":"Miso"}}').pet, { name: 'Miso' });
  assert.throws(() => owner.parse('{"pet":{"kind":"1","name":"Miso"}}'), failsWith(LibErrorKind.Deserialization, /"1"/));
  assert.equal(owner.stringify({ pet: { kind: true, bark: false } }), '{"pet":{"kind":true,"bark":false}}');
});

/** A `Dog` model class that extends the `Cat` one, and the union of their models tagged by `kind`; `catTags` are the tags of `Cat`. */
function catOrDog(catTags: readonly string[]) {
  class ModelCat {}
  class ModelDog extends ModelCat {}
  const union: ModelTypeDescriptor = {
    kind: 'union',
    variants: [{ kind: 'generated-model', id: 'Cat' }, { kind: 'generated-model', id: 'Dog' }],
    discriminator: { propertyName: 'kind', variants: [{ values: [...catTags] }, { values: ['dog'] }] },
  };
  return { ModelCat, ModelDog, union };
}

test('model conversion reads a variant by class and rejects an unknown tag', () => {
  const { ModelCat, ModelDog, union } = catOrDog(['cat', 'kitty']);
  const classNames: Record<string, string> = { Cat: 'ModelCat', Dog: 'ModelDog' };
  const resolveModel = (id: string) => ({
    className: identifier(classNames[id]),
    decode: (value: Code) => code`Object.assign(new ${identifier(classNames[id])}(), ${value})`,
    fromInit: (value: Code) => code`Object.assign(new ${identifier(classNames[id])}(), ${value})`,
  });
  const compile = (converted: Code, direction: 'deserialize'): RuntimeFunction => {
    const { convert } = runModule(
      renderWithHelpers(code`const convert = (value: unknown) => convertModelField(${literal(direction)}, 'pet', (value: unknown) => ${converted}, value);`),
      { ModelCat, ModelDog, unknownDiscriminatorValue: modelRuntime.unknownDiscriminatorValue, withDiscriminatorValue: modelRuntime.withDiscriminatorValue,
        convertModelField: modelRuntime.convertModelField },
      { exports: ['convert'] },
    );
    return convert as RuntimeFunction;
  };
  const fromJson = compile(emitModelFromJSON(union, identifier('value'), resolveModel), 'deserialize');
  assert.ok(fromJson({ kind: 'cat', name: 'Miso' }) instanceof ModelCat);
  assert.ok(!(fromJson({ kind: 'cat', name: 'Miso' }) instanceof ModelDog));

  for (const emit of [emitModelFromJSON, emitModelFromInit]) {
    const decode = compile(emit(union, identifier('value'), resolveModel), 'deserialize');
    const decodedKitty = decode({ kind: 'kitty' });
    assert.ok(decodedKitty instanceof ModelCat, emit.name);
    assert.ok(!(decodedKitty instanceof ModelDog), emit.name);
    const decodedCat = decode({ kind: 'cat' });
    assert.ok(decodedCat instanceof ModelCat, emit.name);
    assert.ok(!(decodedCat instanceof ModelDog), emit.name);
    assert.ok(decode({ kind: 'dog' }) instanceof ModelDog, emit.name);
    const untaggedDog = new ModelDog();
    assert.equal(decode(untaggedDog), untaggedDog, `${emit.name}: an instance selects its class without a tag`);
    assert.throws(
      () => decode({ kind: 'bird' }),
      (error: unknown) => error instanceof LibError
        && error.kind === LibErrorKind.Deserialization
        && JSON.stringify(error.issues[0]?.path) === JSON.stringify(['pet', 'kind']),
      emit.name,
    );
  }
});

test('a union whose branch reads an input of its writer still selects by class and rejects an unknown tag', () => {
  // protects: T-639 a dispatch that cannot become a function of the file keeps the shared selector in its writer
  const { ModelCat, ModelDog, union } = catOrDog(['cat']);
  const owner = inputSlot('owner', 'name');
  const classNames: Record<string, string> = { Cat: 'ModelCat', Dog: 'ModelDog' };
  const resolveModel = (id: string) => ({
    className: identifier(classNames[id]),
    // Each decoded model carries what the writer's function holds in `owner`, which a function of the file could not read.
    decode: (value: Code) => code`Object.assign(new ${identifier(classNames[id])}(), ${value}, { owner: ${inputOf(owner)} })`,
    fromInit: (value: Code) => code`${value}`,
  });
  const converted = bindInput(emitModelFromJSON(union, identifier('value'), resolveModel), owner, identifier('writerOwner'));
  const { convert } = runModule(
    renderWithHelpers(code`const writerOwner = 'writer'; const convert = (value: unknown) => convertModelField('deserialize', 'pet', (value: unknown) => ${converted}, value);`),
    { ModelCat, ModelDog, unknownDiscriminatorValue: modelRuntime.unknownDiscriminatorValue, convertModelField: modelRuntime.convertModelField },
    { exports: ['convert'] },
  ) as { convert: RuntimeFunction };
  const dog = convert({ kind: 'dog' });
  assert.ok(dog instanceof ModelDog);
  assert.equal((dog as { owner: string }).owner, 'writer');
  const untaggedCat = new ModelCat();
  assert.ok(convert(untaggedCat) instanceof ModelCat, 'an instance selects its class without a tag');
  assert.throws(
    () => convert({ kind: 'bird' }),
    (error: unknown) => error instanceof LibError
      && error.kind === LibErrorKind.Deserialization
      && JSON.stringify(error.issues[0]?.path) === JSON.stringify(['pet', 'kind']),
  );
});

test('a short model name shared with an external codec keeps its generated-model schema reference', () => {
  const graph = createSchemaGraph();
  graph.intern(variant({ name: { kind: 'string' } }), 'Shadow');
  // `sdk/Shadow` is another module's model with the same short name.
  graph.intern(variant({
    external: { kind: 'generated-model', id: 'sdk/Shadow' },
    local: { kind: 'union', variants: [{ kind: 'generated-model', id: 'Shadow' }, { kind: 'null' }] },
  }), 'ShadowOwner');
  graph.seal();
  const owner = [...graph.nodes.values()].find((node) => node.name === 'ShadowOwner');
  assert.ok(owner && owner.kind !== 'reference', 'the owner node has a schema');
  const schema = owner.modelJsonSchema as { properties: { external: { $ref: string } } };
  assert.equal(schema.properties.external.$ref, '__exprtGeneratedModel:Shadow', 'the ambiguous name is not rewritten to the local schema');
});
