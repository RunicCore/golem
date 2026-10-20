import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';

import { createFixtureProject } from '../fixture-project.js';
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
      Bag: { type: 'object', additionalProperties: { type: 'string' }, required: ['id'], properties: { id: { type: 'string' } } },
    },
  },
};

type Model = new (values?: object) => object;
type Issues = readonly { readonly code: string; readonly path: readonly unknown[] }[];
type Validator = (value: unknown, all: boolean) => Issues;

test('the own state of an SDK model instance is no unknown key; a declared key stays judged, in a derived model too', async (t) => {
  // protects: bug T-148 program state of an SDK model instance passes, a declared key is still judged on the request plane
  const output = path.join(createFixtureProject(t, 'golem-openapi-instance-state-'), 'sdk');
  await generateMaterializedSdk(document, { output, name: 'InstanceState', profile: { mobx: false, validation: true, allowAny: false } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir: path.join(output, 'dist') });
  const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
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

test('a composed root with validation off stringifies the fields it holds when a required field is missing', async (t) => {
  // protects: bug T-151 the merged allOf root threw on a missing required field that the generic fallback wrote around
  const output = path.join(createFixtureProject(t, 'golem-openapi-composed-lenient-'), 'sdk');
  await generateMaterializedSdk(document, { output, name: 'ComposedLenient', profile: { mobx: false, validation: false, allowAny: false } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir: path.join(output, 'dist') });
  const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
  const [parse, stringify] = [models.parseDerived, models.stringifyDerived] as ((value: unknown) => unknown)[];
  assert.equal(stringify(parse('{"mode":"m"}')), '{"mode":"m"}', 'the required name is missing');
  assert.equal(stringify(parse('{"name":"n","mode":"m"}')), '{"name":"n","mode":"m"}');
});
