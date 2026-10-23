import assert from 'node:assert/strict';
import test from 'node:test';
import { transformSync } from 'esbuild';

import * as conversion from '@exprtlabs/golem/conversion';
import { emitModelFromInit, emitModelFromJSON, emitModelToJSON, render, code, identifier, type Code } from '@exprtlabs/golem/internal/emitter';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { DiscriminatorValue, ModelTypeDescriptor } from '@exprtlabs/golem/model';
import { createSchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import * as serde from '@exprtlabs/golem/serde';
import { instantiateRuntime, type RuntimeFunction, emitCodecRuntimeText } from './emitted-runtime.js';

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
    /** Generated model classes owning their codecs, as in an SDK. */
    readonly classes?: Readonly<Record<string, unknown>>;
    /** Classes the codec constructs for its own variant nodes, as OpenAPI models are. */
    readonly constructed?: Readonly<Record<string, unknown>>;
  },
) {
  const tag: Record<string, ModelTypeDescriptor> = options.taggedVariants ? { kind: { kind: 'string' } } : {};
  const graph = createSchemaGraph();
  // Generated model classes own their variant codecs, as in an SDK; plain variants are graph nodes.
  if (!options.classes) {
    graph.intern(variant({ ...tag, name: { kind: 'string' } }), `${prefix}Cat`, options.constructed !== undefined);
    graph.intern(variant({ ...tag, bark: { kind: 'boolean' } }), `${prefix}Dog`, options.constructed !== undefined);
  } else {
    for (const name of ['Cat', 'Dog']) {
      const constructor = options.classes[`${prefix}${name}Model`] as new () => object;
      // The variant codec writes only the model's own fields, like a generated one.
      serde.createObjectCodec(`${prefix}${name}`, {
        stringify: (value) => JSON.stringify({ ...(value as object) }),
        parse: (text) => Object.assign(new constructor(), JSON.parse(text)) as never,
        validate: () => true,
        assert: (value) => value as never,
        toWireFormat: (value) => ({ ...(value as object) }),
        fromWireFormat: (wire) => Object.assign(new constructor(), wire) as never,
      });
    }
  }
  graph.intern(variant({
    pet: {
      kind: 'union',
      variants: [
        { kind: 'generated-model', id: `${prefix}Cat` },
        { kind: 'generated-model', id: `${prefix}Dog` },
        { kind: 'null' },
      ],
      discriminator: { propertyName: 'kind', variants: [{ values: tags[0] }, { values: tags[1] }, { values: [] }] },
    },
  }), `${prefix}Owner`);
  graph.seal();
  const classes = options.classes ?? options.constructed ?? {};
  const source = emitCodecRuntimeText(graph, {
    validationEnabled: false,
    ...(options.classes ? { nestedGenerated: (id: string) => identifier(`${id}Model`) } : {}),
    ...(options.constructed
      ? { nestedConstruct: (codecId: string) => identifier(`${prefix}${codecId.startsWith(`${prefix}Cat`) ? 'Cat' : 'Dog'}Model`) }
      : {}),
  });
  const runtime = instantiateRuntime(source, {
    ...classes,
    // Test classes are not registered generated models; convert them directly.
    decodeGeneratedModelTrusted: (constructor: new () => object, value: object) =>
      value instanceof constructor ? value : Object.assign(new constructor(), value),
    encodeGeneratedModel: (value: object) => ({ ...value }),
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

test('shared codec writes a variant instance by its class with its own or canonical tag', () => {
  class InstanceCatModel {}
  class InstanceDogModel extends InstanceCatModel {}
  const owner = ownerRuntime('Instance', [['cat', 'kitty'], ['dog']], {
    taggedVariants: false,
    classes: { InstanceCatModel, InstanceDogModel },
  });
  const cat = Object.assign(new InstanceCatModel(), { name: 'Miso' });
  const dog = Object.assign(new InstanceDogModel(), { bark: true });
  const catText = owner.stringify({ pet: cat });
  assert.equal(catText, '{"pet":{"kind":"cat","name":"Miso"}}', 'an untagged instance writes the canonical tag');
  assert.ok(owner.parse(catText).pet instanceof InstanceCatModel);
  const dogText = owner.stringify({ pet: dog });
  assert.equal(dogText, '{"pet":{"kind":"dog","bark":true}}', 'a subclass listed after its base selects itself');
  assert.ok(owner.parse(dogText).pet instanceof InstanceDogModel);
  assert.deepEqual(owner.toWire({ pet: cat }), { pet: { kind: 'cat', name: 'Miso' } });
  assert.deepEqual(owner.toWire({ pet: dog }), { pet: { kind: 'dog', bark: true } });
  const kitty = Object.assign(new InstanceCatModel(), { kind: 'kitty', name: 'Miso' });
  assert.equal(owner.stringify({ pet: kitty }), '{"pet":{"kind":"kitty","name":"Miso"}}', 'an own tag value is kept');
  const mutated = Object.assign(new InstanceCatModel(), { kind: 'dog', name: 'Miso' });
  assert.throws(() => owner.stringify({ pet: mutated }), failsWith(LibErrorKind.Serialization, /"dog"/));
  assert.throws(() => owner.toWire({ pet: mutated }), failsWith(LibErrorKind.Serialization, /"dog"/));
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

test('model conversion writes a variant instance by class and rejects unknown or mutated tags', () => {
  class ModelCat {}
  class ModelDog extends ModelCat {}
  const union: ModelTypeDescriptor = {
    kind: 'union',
    variants: [{ kind: 'generated-model', id: 'Cat' }, { kind: 'generated-model', id: 'Dog' }],
    discriminator: { propertyName: 'kind', variants: [{ values: ['cat', 'kitty'] }, { values: ['dog'] }] },
  };
  const classNames: Record<string, string> = { Cat: 'ModelCat', Dog: 'ModelDog' };
  const resolveModel = (id: string) => ({
    className: identifier(classNames[id]),
    decode: (value: Code) => code`Object.assign(new ${identifier(classNames[id])}(), ${value})`,
    fromInit: (value: Code) => code`Object.assign(new ${identifier(classNames[id])}(), ${value})`,
    encode: (value: Code) => code`({ ...${value} })`,
  });
  const compile = (code: string, direction: 'serialize' | 'deserialize'): RuntimeFunction => {
    const expression = transformSync(`(${code})`, { loader: 'ts', target: 'es2022' }).code.trim().replace(/;$/, '');
    const convert = new Function('ModelCat', 'ModelDog', 'unknownDiscriminatorValue', 'withDiscriminatorValue', 'convertModelField', 'value',
      `return convertModelField(${JSON.stringify(direction)}, 'pet', (value) => ${expression}, value);`) as RuntimeFunction;
    return (value) => convert(ModelCat, ModelDog, conversion.unknownDiscriminatorValue, conversion.withDiscriminatorValue,
      conversion.convertModelField, value);
  };
  const toJson = compile(render(emitModelToJSON(union, identifier('value'), resolveModel)), 'serialize');
  const fromJson = compile(render(emitModelFromJSON(union, identifier('value'), resolveModel)), 'deserialize');
  const cat = Object.assign(new ModelCat(), { name: 'Miso' });
  const wire = toJson(cat);
  assert.deepEqual(wire, { kind: 'cat', name: 'Miso' }, 'an untagged instance writes the canonical tag');
  assert.ok(fromJson(wire) instanceof ModelCat);
  assert.ok(!(fromJson(wire) instanceof ModelDog));
  assert.deepEqual(toJson(Object.assign(new ModelDog(), { bark: true })), { kind: 'dog', bark: true });
  assert.throws(() => toJson(Object.assign(new ModelCat(), { kind: 'dog' })), failsWith(LibErrorKind.Serialization, /"dog"/));
  assert.throws(() => toJson({ kind: 'bird' }), failsWith(LibErrorKind.Serialization, /"bird"/));
  assert.throws(() => toJson({ name: 'Miso' }), failsWith(LibErrorKind.Serialization, /discriminator value/));

  for (const emit of [emitModelFromJSON, emitModelFromInit]) {
    const decode = compile(render(emit(union, identifier('value'), resolveModel)), 'deserialize');
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

test('inferred literal tags require the tag on an instance too', () => {
  class LiteralCat {}
  const union: ModelTypeDescriptor = {
    kind: 'union',
    variants: [{ kind: 'reference', name: 'Cat' }, { kind: 'reference', name: 'Dog' }],
  };
  const resolveModel = (id: string) => ({
    className: identifier(id === 'Cat' ? 'LiteralCat' : 'LiteralDog'),
    discriminators: { kind: id === 'Cat' ? 'cat' : 'dog' },
    decode: (value: Code) => value,
    encode: (value: Code) => code`({ ...${value} })`,
  });
  const expression = transformSync(`(${render(emitModelToJSON(union, identifier('value'), resolveModel))})`, { loader: 'ts', target: 'es2022' })
    .code.trim().replace(/;$/, '');
  const toJson = new Function('LiteralCat', 'LiteralDog', 'unknownDiscriminatorValue', 'withDiscriminatorValue', 'value',
    `return ${expression};`) as RuntimeFunction;
  const run = (value: object) => toJson(LiteralCat, class LiteralDog {}, conversion.unknownDiscriminatorValue,
    conversion.withDiscriminatorValue, value);
  assert.deepEqual(run(Object.assign(new LiteralCat(), { kind: 'cat', name: 'Miso' })), { kind: 'cat', name: 'Miso' });
  assert.throws(() => run(Object.assign(new LiteralCat(), { name: 'Miso' })), failsWith(LibErrorKind.Serialization, /undefined/),
    'the variant schema requires its literal tag, so encoding must not invent it');
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
