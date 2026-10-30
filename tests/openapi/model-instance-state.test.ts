import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';

import { createFixtureProject, fileFixtureScope, onceShared } from '../fixture-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, sdkBodyCodec, withRootOperations, type SdkBodyCodec } from './helpers.js';

// What an SDK client writes for a body that has keys its schema does not declare, and for a body that lacks a required key. The SDK has no model
// class, so there is no instance and no program state of one; the same rules for the models of an app are proved in tests/model-instance-state.test.ts.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const SCHEMAS = {
  // serverId is declared by the model, and the request plane forbids it.
  Item: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, serverId: { type: 'string', readOnly: true } } },
  Base: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  Derived: {
    allOf: [ref('Base'), { type: 'object', properties: { mode: { type: 'string' }, serverId: { type: 'string', readOnly: true } } }],
    unevaluatedProperties: false,
  },
  // An allOf with a union member is an alias of the union of merged objects, so a holder reaches it through a field (T-220).
  MixedHolder: { type: 'object', required: ['value'], properties: { value: ref('Mixed') } },
  Mixed: { allOf: [ref('Base'), { oneOf: [{ type: 'object', required: ['kind', 'a'], properties: { kind: { const: 'a' }, a: { type: 'string' } } }, { type: 'object', required: ['kind', 'b'], properties: { kind: { const: 'b' }, b: { type: 'string' } } }] }] },
  Tree: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, child: ref('Tree') } },
  Open: { type: 'object', additionalProperties: true, required: ['id'], properties: { id: { type: 'string' } } },
  // An object that declares no field and is open by an explicit additionalProperties true.
  EmptyOpen: { type: 'object', additionalProperties: true },
  // Composed roots: open by an explicit additionalProperties true on a member or on the root.
  ComposedOpenInline: { allOf: [{ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, { additionalProperties: true }] },
  ComposedOpenRef: { allOf: [ref('Base'), { additionalProperties: true }] },
  ComposedOwnRef: { allOf: [ref('Base')], additionalProperties: true },
  ComposedOpenRoot: { allOf: [{ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, { type: 'object', properties: { tag: { type: 'string' } } }], additionalProperties: true },
  Bag: { type: 'object', additionalProperties: { type: 'string' }, required: ['id'], properties: { id: { type: 'string' } } },
  // A converted field (date-time), to read through the client.
  Stamped: { type: 'object', properties: { name: { type: 'string' }, at: { type: 'string', format: 'date-time' } } },
};

const document = withRootOperations({
  openapi: '3.1.0',
  info: { title: 'Instance state', version: '1' },
  components: { schemas: SCHEMAS },
}, ...Object.keys(SCHEMAS));

// Each SDK is generated and compiled once for the file: one with validation on, one with it off.
const scope = fileFixtureScope();
const buildSdk = (name: string, validation: boolean) => async () => {
  const output = path.join(createFixtureProject(scope, `golem-openapi-${name}-`), 'sdk');
  await generateMaterializedSdk(document, { output, name, profile: { mobx: false, validation, allowAny: false } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir: path.join(output, 'dist') });
  return (root: keyof typeof SCHEMAS): Promise<SdkBodyCodec> => sdkBodyCodec(output, name, root);
};
const validatedSdk = onceShared(buildSdk('ValidatedState', true));
const unvalidatedSdk = onceShared(buildSdk('UnvalidatedState', false));

const isValidation = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;

test('a declared readOnly key is forbidden in a request and carried in a response, in a derived model too', async () => {
  // protects: bug T-148 a declared key is still judged on the request plane
  const codec = await validatedSdk();
  const [item, derived] = [await codec('Item'), await codec('Derived')];
  assert.deepEqual(await item.encode({ name: 'n' }), { name: 'n' });
  await assert.rejects(item.encode({ name: 'n', serverId: 's' }), isValidation, 'the declared serverId is forbidden on the request plane');
  assert.deepEqual(await item.decode({ name: 'n', serverId: 's' }), { name: 'n', serverId: 's' }, 'the response plane carries serverId');
  assert.deepEqual(await derived.encode({ name: 'n', mode: 'm' }), { name: 'n', mode: 'm' }, 'a derived model under unevaluatedProperties');
  await assert.rejects(derived.encode({ name: 'n', serverId: 's' }), isValidation, 'the declared serverId of the derived model');
});

test('a dynamic-map model and a model with additionalProperties true write their extra keys as data', async () => {
  // protects: bug T-154 the codec wrote the declared fields only, where an explicit additionalProperties true keeps the extra keys
  const codec = await validatedSdk();
  const [bag, open] = [await codec('Bag'), await codec('Open')];
  assert.deepEqual(await bag.encode({ id: 'a', extra: 'x' }), { id: 'a', extra: 'x' });
  assert.deepEqual(await bag.decode({ id: 'a', extra: 'x' }), { id: 'a', extra: 'x' });
  assert.deepEqual(await open.encode({ id: 'a', extra: 'x' }), { id: 'a', extra: 'x' });
});

test('an object that is open only by default and converts a field writes its declared fields only', async () => {
  // protects: F-56 the conversion writes the declared fields; only an explicit additionalProperties true keeps extra keys
  const stamped = await (await validatedSdk())('Stamped');
  assert.deepEqual(await stamped.encode({ name: 'n', at: new Date('2024-01-02T03:04:05.000Z'), extra: 'x' }), { name: 'n', at: '2024-01-02T03:04:05.000Z' });
});

test('a composition with a union member writes the fields of both members, with validation on and off', async () => {
  // protects: bug T-155 the fallback of a composed root wrote every own key
  const wire = { value: { name: 'n', kind: 'a', a: 'x' } };
  for (const sdk of [validatedSdk, unvalidatedSdk]) assert.deepEqual(await (await (await sdk())('MixedHolder')).encode(wire), wire);
});

test('with validation off an object that lacks a required field is written with the fields it holds, nested too; validation on rejects it', async () => {
  // protects: bug T-156 a plain root threw a TypeError on a missing required field with validation off
  const codec = await validatedSdk();
  const [item, base, tree] = [await codec('Item'), await codec('Base'), await codec('Tree')];
  assert.deepEqual(await item.encode({ serverId: 's' }, { validate: false }), { serverId: 's' }, 'the required name is missing');
  assert.deepEqual(await base.encode({}, { validate: false }), {}, 'a root that holds no field');
  assert.deepEqual(await tree.encode({ label: 'a', child: {} }, { validate: false }), { label: 'a', child: {} });
  assert.deepEqual(await tree.encode({ label: 'a', child: { label: 'b' } }), { label: 'a', child: { label: 'b' } });
  await assert.rejects(item.encode({ serverId: 's' }), isValidation, 'validation on rejects the missing field');
});

for (const [name, root, required] of [
  ['a member with additionalProperties true', 'ComposedOpenInline', { id: 'a' }],
  ['a model base and a member with additionalProperties true', 'ComposedOpenRef', { name: 'a' }],
  ['a model base and additionalProperties true on the root', 'ComposedOwnRef', { name: 'a' }],
  ['additionalProperties true on the root', 'ComposedOpenRoot', { id: 'a' }],
  ['no declared field and additionalProperties true', 'EmptyOpen', {}],
] as const) {
  test(`a root with ${name} keeps its extra keys in a request`, async () => {
    // protects: bug T-159 a composed root did not carry additionalPropertiesDeclared, so an explicit additionalProperties true lost its extra keys (F-200)
    const codec = await (await validatedSdk())(root);
    assert.deepEqual(await codec.encode({ ...required, extra: 'x' }), { ...required, extra: 'x' });
  });
}

test('the client reads a getter of the body once when it writes a converted field', async () => {
  // protects: F-286 encode reads each declared field by property access, once
  const stamped = await (await unvalidatedSdk())('Stamped');
  let reads = 0;
  const body = Object.defineProperty({}, 'at', { enumerable: true, get() { reads += 1; return new Date('2024-01-02T03:04:05.000Z'); } });
  assert.deepEqual(await stamped.encode(body), { at: '2024-01-02T03:04:05.000Z' });
  assert.equal(reads, 1);
});
