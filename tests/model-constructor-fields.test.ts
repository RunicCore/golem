import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { fileFixtureScope, onceShared, readFixture } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { modelCodec } from './support/model-codec.js';

interface ItemLike { id: number; label: string; child: { name: string } }
type ItemClass = new (values?: object) => ItemLike;

const scope = fileFixtureScope();
const build = onceShared(async () => {
  const { root, sourceRoot } = createModelProject(scope, { prefix: 'golem-model-ctor-fields-', name: 'model-constructor-fields', linkWorkspaceNodeModules: true });
  for (const file of ['child.model.ts', 'item.model.ts']) fs.writeFileSync(path.join(sourceRoot, file), readFixture(`models/model-constructor-fields/${file}`));
  writeModelGolemYaml(root, { validation: false });
  await buildModelProject(root);
  const child = await import(pathToFileURL(path.join(root, 'build/child.model.js')).href);
  const item = await import(pathToFileURL(path.join(root, 'build/item.model.js')).href);
  return { Child: child.Child as ItemClass, Item: item.Item as ItemClass, Guarded: item.Guarded as ItemClass, Late: item.Late as ItemClass, setterCalls: item.setterCalls as { count: number } };
});

const ownData = (target: object, name: string) => Object.getOwnPropertyDescriptor(target, name);
const dataOf = (value: unknown) => ({ value, enumerable: true, configurable: true, writable: true });

test('a subclass with an accessor for a declared field gets an own data property from the constructor and from decode', async () => {
  // protects: F-33 a subclass of the generated base keeps working: its prototype setter never runs, and every field is an own data property
  const { Child, Item, Guarded, setterCalls } = await build();
  new Item({ id: 0, label: 'plain', child: { name: 'first' } });
  const wire = { id: 1, label: 'a', child: { name: 'c' } };
  const made = [new Guarded({ id: 1, label: 'a', child: { name: 'c' } }), new Guarded({ id: 1, label: 'a', child: { name: 'c' } }), modelCodec(Guarded).fromWireFormat(wire)];
  assert.equal(setterCalls.count, 0);
  for (const model of made) {
    assert.deepEqual(ownData(model, 'id'), dataOf(1));
    assert.deepEqual(ownData(model, 'label'), dataOf('a'));
    assert.equal(ownData(model, 'child')?.enumerable, true);
    assert.equal(ownData(model, 'child')?.value instanceof Child, true);
    assert.equal(model.child.name, 'c');
  }
});

test('a plain subclass of the generated base keeps its fields as own data properties and its wire form', async () => {
  // protects: F-33 a subclass without accessors constructs, decodes and encodes as before
  const { Child, Item } = await build();
  const wire = { id: 2, label: 'b', child: { name: 'd' } };
  const built = new Item({ id: 2, label: 'b', child: { name: 'd' } });
  const decoded = modelCodec(Item).fromWireFormat(wire);
  for (const model of [built, decoded]) {
    assert.deepEqual(ownData(model, 'id'), dataOf(2));
    assert.equal(model.child instanceof Child, true);
    assert.deepEqual(modelCodec(model).toWireFormat(model), wire);
    assert.equal(JSON.stringify(model), '{"id":2,"label":"b","child":{"name":"d"}}');
  }
  assert.deepEqual(Object.keys(new Item({ label: 'only' })), ['label']);
});

test('a setter added to the prototype after the first construction is still bypassed', async () => {
  // protects: F-33 a prototype setter never runs, also one added after the class built its first instance
  const { Late } = await build();
  const setterCalls: unknown[] = [];
  const first = new Late({ id: 1, label: 'a' });
  assert.deepEqual(ownData(first, 'id'), dataOf(1));
  Object.defineProperty(Late.prototype, 'id', { configurable: true, get: () => undefined, set: (value: unknown) => { setterCalls.push(value); } });
  const made = [new Late({ id: 2, label: 'b' }), modelCodec(Late).fromWireFormat({ id: 2, label: 'b' })];
  assert.deepEqual(setterCalls, []);
  for (const model of made) {
    assert.deepEqual(ownData(model, 'id'), dataOf(2));
    assert.deepEqual(ownData(model, 'label'), dataOf('b'));
  }
});
