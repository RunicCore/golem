import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { LibError } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';

import { createFixtureProject, fileFixtureScope, onceShared } from '../fixture-project.js';
import { generatedCodecIdFromRoot } from '../support/consumer.js';
import { compileGeneratedSdk, generateMaterializedSdk, requireRecord } from './helpers.js';

// An own key of a golem-openapi model instance that its own model does not declare is program state, never an unknown
// key (T-148). A key that the model declares is judged as before; a dynamic-map model has no program state.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string) => ({ 'application/json': { schema: ref(name) } });
const post = (operationId: string, name: string) => ({
  post: { operationId, requestBody: { required: true, content: json(name) }, responses: { 201: { description: 'created', content: json(name) } } },
});

const document = {
  openapi: '3.1.0',
  info: { title: 'Instance state', version: '1' },
  paths: { '/items': post('createItem', 'Item'), '/derived': post('createDerived', 'Derived'), '/mixed': post('createMixed', 'Mixed') },
  components: {
    schemas: {
      // serverId is declared by the model, and the request plane forbids it.
      Item: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, serverId: { type: 'string', readOnly: true } } },
      Base: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      Derived: {
        allOf: [ref('Base'), { type: 'object', properties: { mode: { type: 'string' }, serverId: { type: 'string', readOnly: true } } }],
        unevaluatedProperties: false,
      },
      // A member that is no object (a oneOf) does not resolve to one merged object.
      Mixed: { allOf: [ref('Base'), { oneOf: [{ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, { type: 'object', required: ['b'], properties: { b: { type: 'string' } } }] }] },
      Holder: { type: 'object', required: ['base'], properties: { base: ref('Base') } },
      Tree: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, child: ref('Tree') } },
      Open: { type: 'object', additionalProperties: true, required: ['id'], properties: { id: { type: 'string' } } },
      // Objects that declare no field: closed, open only by default, and open by an explicit additionalProperties true.
      EmptyClosed: { type: 'object', additionalProperties: false },
      EmptyDefault: { type: 'object', properties: {} },
      EmptyOpen: { type: 'object', additionalProperties: true },
      // A field of unknown type, and a composed root with a model in a field.
      Note: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, data: {} } },
      Lead: { allOf: [{ type: 'object', required: ['lead'], properties: { lead: ref('Base') } }, { oneOf: [{ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, { type: 'object', required: ['b'], properties: { b: { type: 'string' } } }] }] },
      Bag: { type: 'object', additionalProperties: { type: 'string' }, required: ['id'], properties: { id: { type: 'string' } } },
      // A plain field and a converted one (date-time), to read through the constructor, decode and encode.
      Stamped: { type: 'object', properties: { name: { type: 'string' }, at: { type: 'string', format: 'date-time' } } },
    },
  },
};

type Model = new (values?: object) => object;
type Issues = readonly { readonly code: string; readonly path: readonly unknown[] }[];
type Validator = (value: unknown, all: boolean) => Issues;

test('the own state of an SDK model instance is no unknown key; a declared key stays judged, in a derived model too', async () => {
  // protects: bug T-148 program state of an SDK model instance passes, a declared key is still judged on the request plane
  const { output, models } = await validatedSdk();
  const validators = await import(pathToFileURL(path.join(output, 'dist/validators.generated.js')).href) as Record<string, Validator>;
  const [Item, Base, Derived, Bag] = [models.ItemModel, models.BaseModel, models.DerivedModel, models.BagModel] as Model[];
  const issues = (operation: string, body: object) => validators[`validate_${operation}_input`]({ body }, true).map(issue => [issue.code, issue.path]);
  const state = { cache: new Map<string, string>(), hits: 3 };

  assert.deepEqual(issues('createItem', Object.assign(new Item({ name: 'n' }), state)), [], 'a model with a closed key set');
  assert.deepEqual(issues('createItem', new Item({ name: 'n', serverId: 's' })), [['unknownKey', ['body', 'serverId']]], 'the declared serverId is forbidden on the request plane');
  assert.deepEqual(issues('createDerived', Object.assign(new Derived({ name: 'n', mode: 'm' }), state)), [], 'a derived model under unevaluatedProperties');
  assert.deepEqual(issues('createDerived', new Derived({ name: 'n', serverId: 's' })), [['unknownKey', ['body', 'serverId']]], 'the declared serverId of the derived model');
  assert.deepEqual(validators.validate_createItem_response_201_application_json(new Item({ name: 'n', serverId: 's' }), true), [], 'the response plane carries serverId');

  const stringified = (root: string, value: object) => requireObjectCodec(generatedCodecIdFromRoot(output, root)).stringify(value);
  assert.equal(stringified('Item', Object.assign(new Item({ name: 'n' }), state)), '{"name":"n"}');
  assert.equal(stringified('Base', Object.assign(new Base({ name: 'n' }), state)), '{"name":"n"}', 'an open model');
  const derived = requireObjectCodec(generatedCodecIdFromRoot(output, 'Derived'));
  const withState = Object.assign(new Derived({ name: 'n', mode: 'm' }), state);
  assert.equal(derived.validate(withState), true);
  assert.deepEqual(derived.toWireFormat(withState), { name: 'n', mode: 'm' });
  assert.equal(derived.stringify(withState), '{"name":"n","mode":"m"}', 'the composed root writes its declared fields only');
  assert.throws(() => derived.stringify({ name: 'n', cache: 1 }), (error: unknown) => error instanceof LibError, 'a plain value with an extra key is judged as input');

  assert.equal(stringified('Mixed', { name: 'n', a: 'x' }), '{"name":"n","a":"x"}', 'a composition with a member that is no object keeps the fields of both members');
  const bag = requireObjectCodec(generatedCodecIdFromRoot(output, 'Bag'));
  const map = Object.assign(new Bag({ id: 'a' }), { extra: 'x' });
  assert.equal(bag.validate(map), true);
  assert.equal(bag.stringify(map), '{"id":"a","extra":"x"}', 'a dynamic-map model writes its extra keys as data');
  assert.deepEqual(bag.toWireFormat(map), { id: 'a', extra: 'x' });
});

test('a composed root with a member that is no object stringifies the declared fields of a model instance only', async () => {
  // protects: bug T-155 the fallback of a composed root wrote every own key, program state of a model instance included
  const { models } = await unvalidatedSdk();
  const Mixed = models.MixedModel as Model;
  const stringify = models.stringifyMixed as (value: unknown) => string;
  assert.equal(stringify(Object.assign(new Mixed({ name: 'n' }), { cache: new Map<string, string>(), hits: 3 })), '{"name":"n"}');
  assert.equal(stringify({ name: 'n', a: 'x' }), '{"name":"n","a":"x"}', 'a plain value is written as it is');
});

// Each SDK is generated and compiled once for the file: one with validation on, one with it off.
const scope = fileFixtureScope();
const buildSdk = (name: string, validation: boolean) => async () => {
  const output = path.join(createFixtureProject(scope, `golem-openapi-${name}-`), 'sdk');
  await generateMaterializedSdk(document, { output, name, profile: { mobx: false, validation, allowAny: false } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir: path.join(output, 'dist') });
  const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
  return { output, models };
};
const validatedSdk = onceShared(buildSdk('ValidatedState', true));
const unvalidatedSdk = onceShared(buildSdk('UnvalidatedState', false));

async function generateOpen() {
  const { output, models } = await validatedSdk();
  const Open = models.OpenModel as Model;
  return { codec: requireObjectCodec(generatedCodecIdFromRoot(output, 'Open')), instance: Object.assign(new Open({ id: 'a' }), { extra: 'x' }) };
}

test('stringify writes the extra keys of a model with additionalProperties true as data', async () => {
  // protects: bug T-154 the codec wrote the declared fields only, where encodeGeneratedModel keeps the extra keys
  const { codec, instance } = await generateOpen();
  assert.equal(codec.stringify(instance), '{"id":"a","extra":"x"}');
  assert.equal(codec.stringify({ id: 'a', extra: 'x' }), '{"id":"a","extra":"x"}', 'a plain value');
});

test('toWireFormat keeps the extra keys of a model with additionalProperties true as data', async () => {
  // protects: bug T-154 the codec wire encoding dropped the extra keys, where encodeGeneratedModel keeps them
  const { codec, instance } = await generateOpen();
  assert.deepEqual(codec.toWireFormat(instance), { id: 'a', extra: 'x' });
  assert.deepEqual(codec.toWireFormat({ id: 'a', extra: 'x' }), { id: 'a', extra: 'x' }, 'a plain value');
});

test('an object root with validation off stringifies the fields it holds when a required field is missing', async () => {
  // protects: bug T-156 a plain root threw a TypeError on a missing required field with validation off; validation on still rejects it
  const { models } = await validatedSdk();
  const [stringifyItem, stringifyBase] = [models.stringifyItem, models.stringifyBase] as ((value: unknown, options?: { validate: boolean }) => string)[];
  assert.equal(stringifyItem({ serverId: 's' }, { validate: false }), '{"serverId":"s"}', 'the required name is missing');
  assert.equal(stringifyBase({}, { validate: false }), '{}', 'a root that holds no field');
  assert.equal(stringifyItem({ name: 'n', serverId: 's' }), '{"name":"n","serverId":"s"}');
  assert.throws(() => stringifyItem({ serverId: 's' }), (error: unknown) => error instanceof LibError, 'validation on still rejects the missing field');
});

test('an object that is open only by default writes its declared fields only, in stringify and toWireFormat', async () => {
  // protects: F-56 stringify writes the declared fields; only an explicit additionalProperties true keeps extra keys
  const { output } = await validatedSdk();
  const base = requireObjectCodec(generatedCodecIdFromRoot(output, 'Base'));
  assert.equal(base.stringify({ name: 'n', extra: 'x' }), '{"name":"n"}');
  assert.deepEqual(base.toWireFormat({ name: 'n', extra: 'x' }), { name: 'n' });
});

test('a composed root with a member that is no object encodes the declared fields of a model instance only', async () => {
  // protects: P-10 no codec writes program state; toWireFormat of this root returned the instance as it was
  const { output, models } = await unvalidatedSdk();
  const Mixed = models.MixedModel as Model;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Mixed'));
  assert.deepEqual(codec.toWireFormat(Object.assign(new Mixed({ name: 'n' }), { cache: new Map<string, string>(), hits: 3 })), { name: 'n' });
  assert.deepEqual(codec.toWireFormat({ name: 'n', a: 'x' }), { name: 'n', a: 'x' }, 'a plain value is kept');
});

test('with validation off a nested object that lacks a required field is written with the fields it holds', async () => {
  // protects: T-156 a nested object of the same module threw a TypeError on a missing required field where its parent wrote around it
  const { models } = await validatedSdk();
  const stringifyTree = models.stringifyTree as (value: unknown, options?: { validate: boolean }) => string;
  assert.equal(stringifyTree({ label: 'a', child: {} }, { validate: false }), '{"label":"a","child":{}}');
  assert.equal(stringifyTree({ label: 'a', child: { label: 'b' } }), '{"label":"a","child":{"label":"b"}}');
});

test('a validated parent trusts its check: a child of another module writes its required fields without a presence test', async () => {
  // protects: T-156 validation off writes around a missing field, but a validated call keeps the all-required fast path
  const { models } = await validatedSdk();
  const stringifyHolder = models.stringifyHolder as (value: unknown, options?: { validate?: boolean; validationContext?: unknown }) => string;
  const acceptAll = { resolve: () => () => [] };
  assert.throws(() => stringifyHolder({ base: {} }, { validationContext: acceptAll }), TypeError, 'the check accepted the missing name');
  assert.equal(stringifyHolder({ base: {} }, { validate: false }), '{"base":{}}', 'validation off writes what is there');
});

test('options a user passes with a checked key still take the lenient path', async () => {
  // protects: bug T-156 the internal checked mark was a plain key, so user options carrying it skipped the lenient path
  const { models } = await validatedSdk();
  const stringifyItem = models.stringifyItem as (value: unknown, options?: object) => string;
  assert.equal(stringifyItem({ serverId: 's' }, { validate: false, checked: true }), '{"serverId":"s"}', 'the missing name is left out');
});

const programState = () => ({ cache: new Map<string, string>(), hits: 3 });

for (const [name, root, keeps] of [['closed', 'EmptyClosed', false], ['open only by default', 'EmptyDefault', false], ['open by an explicit additionalProperties true', 'EmptyOpen', true]] as const) {
  test(`an object with no declared field and ${name} writes the same in stringify and toWireFormat`, async () => {
    // protects: bug T-158 toWireFormat of a model with no declared field returned the instance with its program state; stringify wrote {}
    const { output, models } = await validatedSdk();
    const Model = models[`${root}Model`] as Model;
    const codec = requireObjectCodec(generatedCodecIdFromRoot(output, root));
    // An instance of a model with an explicit additionalProperties true has no program state: its own keys are data.
    const state = Object.assign(new Model({}), keeps ? { extra: 'x' } : programState());
    const wire = codec.toWireFormat(state);
    assert.deepEqual(wire, keeps ? { extra: 'x' } : {}, 'program state is never written');
    assert.notEqual(wire, state, 'the wire value is not the instance');
    assert.equal(codec.stringify(state), keeps ? '{"extra":"x"}' : '{}');
    const plain = { extra: 'x' };
    assert.deepEqual(codec.toWireFormat(plain), keeps ? { extra: 'x' } : {}, 'a plain value');
    assert.equal(codec.stringify(plain), keeps ? '{"extra":"x"}' : '{}', 'a plain value');
  });
}

for (const validation of [true, false]) {
  test(`a model instance at any depth in an unknown field writes no program state (validation ${validation ? 'on' : 'off'})`, async () => {
    // protects: bug T-164 only the top value of an unknown field lost its program state; an instance inside an array or object kept it
    const { output, models } = await (validation ? validatedSdk : unvalidatedSdk)();
    const [Base, EmptyOpen] = [models.BaseModel, models.EmptyOpenModel] as Model[];
    const note = requireObjectCodec(generatedCodecIdFromRoot(output, 'Note'));
    const task = () => Object.assign(new Base({ name: 't' }), programState());
    const cases: readonly [string, unknown, unknown][] = [
      ['an array', [task()], [{ name: 't' }]],
      ['a nested plain object', { inner: { list: [1, task()] } }, { inner: { list: [1, { name: 't' }] } }],
      ['an instance', task(), { name: 't' }],
      ['a value with no model instance', { a: [1, { b: null }], c: 'x', d: [] }, { a: [1, { b: null }], c: 'x', d: [] }],
      ['a scalar', 'text', 'text'],
    ];
    for (const [label, data, expected] of cases) {
      const value = { title: 'n', data };
      assert.deepEqual(note.toWireFormat(value), { title: 'n', data: expected }, `toWireFormat of ${label}`);
      assert.equal(note.stringify(value), JSON.stringify({ title: 'n', data: expected }), `stringify of ${label}`);
    }
    const open = codec('EmptyOpen');
    const extra = Object.assign(new EmptyOpen({}), { extra: task() });
    assert.deepEqual(open.toWireFormat(extra), { extra: { name: 't' } }, 'an extra key of an explicit additionalProperties true');
    assert.equal(open.stringify(extra), '{"extra":{"name":"t"}}');

    function codec(root: string) { return requireObjectCodec(generatedCodecIdFromRoot(output, root)); }
  });
}

test('a model instance in a field of a composed root writes no program state', async () => {
  // protects: bug T-157 a composed root with a member that is no object wrote an instance of a field as it was
  const { output, models } = await unvalidatedSdk();
  const Base = models.BaseModel as Model;
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Lead'));
  const value = { lead: Object.assign(new Base({ name: 'n' }), programState()), a: 'x' };
  assert.deepEqual(codec.toWireFormat(value), { lead: { name: 'n' }, a: 'x' });
  assert.equal(codec.stringify(value), '{"lead":{"name":"n"},"a":"x"}');
});

test('the class-level encode of an SDK model writes no program state of an instance inside its unknown field', async () => {
  // protects: bug T-164 a model nested as a field of another model is encoded by the class-level encode, which kept the state of an instance in its unknown field
  const { models } = await validatedSdk();
  const [Base, Note] = [models.BaseModel, models.NoteModel] as Model[];
  const task = Object.assign(new Base({ name: 't' }), programState());
  assert.deepEqual(encodeGeneratedModel(new Note({ title: 'n', data: { list: [task] } })), { title: 'n', data: { list: [{ name: 't' }] } });
  assert.deepEqual(encodeGeneratedModel(new Note({ title: 'n', data: task })), { title: 'n', data: { name: 't' } });
});

test('an SDK model constructor, decode and encode count only own enumerable keys, and a constructor or encode getter runs once', async () => {
  // protects: bug T-162 the constructor copied an inherited value (values["name"] !== undefined), against the own-key rule of presence.ts
  const { models } = await validatedSdk();
  const Stamped = models.StampedModel as new (values?: object) => { name?: string; at?: Date };
  const instance = (values: object) => new Stamped(values);
  const inherited = () => Object.create({ name: 'x', at: '2024-01-02T03:04:05.000Z' }) as object;
  const counted = (key: string, value: unknown) => {
    const reads = { count: 0 };
    const own = Object.defineProperty({}, key, { enumerable: true, get() { reads.count += 1; return value; } });
    return { own, reads };
  };

  assert.deepEqual({ ...instance(inherited()) }, {}, 'the constructor leaves an inherited value out');
  assert.equal(instance({ name: 'x' }).name, 'x', 'the constructor copies an own value');
  const ctorGetter = counted('name', 'x');
  assert.equal(instance(ctorGetter.own).name, 'x');
  assert.equal(ctorGetter.reads.count, 1, 'the constructor reads an own getter once');

  assert.deepEqual({ ...decodeGeneratedModel(Stamped, inherited()) }, {}, 'decode leaves an inherited value out');
  assert.deepEqual({ ...decodeGeneratedModel(Stamped, { at: '2024-01-02T03:04:05.000Z' }) }, { at: new Date('2024-01-02T03:04:05.000Z') }, 'decode converts an own value');

  const prototype = Object.assign(new Stamped(), { name: 'x', at: new Date('2024-01-02T03:04:05.000Z') });
  assert.deepEqual(encodeGeneratedModel(Object.create(prototype)), {}, 'encode leaves an inherited value out');
  assert.deepEqual(encodeGeneratedModel(instance({ at: new Date('2024-01-02T03:04:05.000Z') })), { at: '2024-01-02T03:04:05.000Z' }, 'encode writes an own value');
  let encodeReads = 0;
  const encodeGetter = Object.defineProperty(new Stamped(), 'at', { enumerable: true, get() { encodeReads += 1; return new Date('2024-01-02T03:04:05.000Z'); } });
  assert.deepEqual(encodeGeneratedModel(encodeGetter), { at: '2024-01-02T03:04:05.000Z' });
  assert.equal(encodeReads, 1, 'encode reads an own getter once');
});
