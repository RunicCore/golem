import { readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { generatedCodecId, generatedCodecIdFromRoot } from './support/consumer.js';
import { compositionProject as fixture } from './support/model-composition-project.js';
import { buildModelProject, generatedModelFiles, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { projectionPolicyModelSource } from './fixture-templates/models/model-composition.js';
import { generate } from '#model/generator';

/** The nested-projection contract, run in the shared project (validation on) and in its own project (validation off). */
async function assertNestedProjections(root: string, buildFile: string, validation: boolean): Promise<void> {
  const { Address, Customer } = await import(path.join(root, buildFile));
  const original = new Address({ id: 'drop', city: 'Paris' });
  const customer = new Customer({ address: original, delivery: {}, intact: { id: 'keep', city: 'Paris' }, readonlyAddress: original });
  assert.equal(Object.getPrototypeOf(customer.address), Object.prototype);
  assert.deepEqual(customer.address, { city: 'Paris' });
  assert.deepEqual(customer.delivery, {});
  assert.ok(customer.intact instanceof Address);
  assert.equal(Object.getPrototypeOf(customer.readonlyAddress), Object.prototype);
  assert.notEqual(customer.readonlyAddress, original);
  const wire = encodeGeneratedModel(customer) as { address: unknown };
  assert.deepEqual(wire.address, { city: 'Paris' });
  const input = { address: { id: 'strip', city: 'Paris' }, delivery: {}, intact: { id: 'keep', city: 'Paris' }, readonlyAddress: { id: 'ok', city: 'Paris' } };
  const decoded = decodeGeneratedModel(Customer, input);
  assert.deepEqual(decoded.address, { city: 'Paris' });
  assert.ok(decoded.intact instanceof Address);
  assert.equal(input.address.id, 'strip');
  if (validation) assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'TCustomer')).assert( { ...input, address: { city: 'x' } }));
}

test('nested projections strip omitted fields and retain intact child models with validation=false', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'address.model.ts'), readFixture("models/model-composition/model-composition-address-model/address.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  await assertNestedProjections(root, 'build/address.model.js', false);
});

test('projection decoders and encoders copy fields with assignments and keep the prototype untouched', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'place.model.ts'), readFixture("models/model-composition/projection-decoders-copy-fields-with-assignments/place.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const companion = generatedModelFiles(root).find(artifact => artifact.path.endsWith('place.model.generated.ts'))!.content;
  for (const direction of ['decode', 'encode']) {
    const helper = companion.split('\n').find(line => line.startsWith(`function ${direction}TPlaceOmitId(`));
    assert.ok(helper);
    assert.doesNotMatch(helper, /Object\.fromEntries/);
  }
  const { Office } = await import(path.join(root, 'build/place.model.js'));
  const place = JSON.parse('{"city":"Hue","country":"VN","__proto__":{"x":1}}');
  const office = decodeGeneratedModel(Office, { place }) as { place: Record<string, unknown> };
  assert.equal(Object.getPrototypeOf(office.place), Object.prototype);
  assert.deepEqual(office.place, { city: 'Hue', country: 'VN' });
  assert.deepEqual(encodeGeneratedModel(office), { place: { city: 'Hue', country: 'VN' } });
});

test('a projection decoder leaves out a field that is undefined or not enumerable in the input', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'place.model.ts'), readFixture("models/model-composition/projection-decoders-copy-fields-with-assignments/place.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const { Office } = await import(path.join(root, 'build/place.model.js'));
  const hidden = Object.defineProperty({ city: 'Hue' }, 'country', { value: 'VN', enumerable: false });
  assert.deepEqual(Object.keys(decodeGeneratedModel(Office, { place: { city: 'Hue', country: undefined } }).place), ['city']);
  assert.deepEqual(Object.keys(decodeGeneratedModel(Office, { place: hidden }).place), ['city']);
});

test('a projection decoder leaves out an undeclared key whose value is undefined', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'board.model.ts'), readFixture("models/model-composition/projection-extras/board.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const { Board } = await import(path.join(root, 'build/board.model.js'));
  const board = decodeGeneratedModel(Board, { slots: { x: undefined, y: { at: '2026-01-02T00:00:00.000Z' } } });
  assert.deepEqual(Object.keys(board.slots), ['y']);
  assert.ok(board.slots.y.at instanceof Date);
});

test('equivalent projections share helpers and execute only retained field codecs', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-composition/equivalent-projections-share-helpers-and-execute-only-retained-field-codecs/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/equivalent-projections-share-helpers-and-execute-only-retained-field-codecs/item.model.ts"));
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const companion = generatedModelFiles(root).find(artifact => artifact.path.endsWith('item.model.generated.ts'))!.content;
  assert.equal([...companion.matchAll(/function decodeTItemOmitId\(/g)].length, 1);
  assert.equal([...companion.matchAll(/function initTItemOmitId\(/g)].length, 1);
  assert.equal([...companion.matchAll(/function encodeTItemOmitId\(/g)].length, 1);
  const { Container } = await import(path.join(root, 'build/item.model.js'));
  const codecs = await import(path.join(root, 'build/codecs.js'));
  const model = decodeGeneratedModel(Container, { first: { id: 'ignored', value: 'HELLO' } });
  assert.deepEqual(model.first, { value: 'hello' });
  assert.equal(codecs.retained, 1);
  assert.equal(codecs.removed, 0);
  assert.deepEqual(encodeGeneratedModel(model), { first: { value: 'HELLO' } });
  assert.equal(codecs.retained, 2);
  assert.equal(codecs.removed, 0);
});

// One project holds every validation=true, mobx=false case that only decodes and encodes; each case
// keeps its own directory, so the same class names never share a module. Cases that assert a
// diagnostic (or need another profile) stay in projects of their own.
test('validation-on projection cases share one generated project', async t => {
  const { root, sourceRoot } = fixture(t);
  const composition = (name: string, file: string): string => readFixture(`models/model-composition/${name}/${file}`);
  writeModelSources(sourceRoot, {
    'nested-projections/address.model.ts': composition('model-composition-address-model', 'address.model.ts'),
    'nested-unions/contacts.model.ts': composition('nested-unions-and-selection-utilities-retain-declaration-identities', 'contacts.model.ts'),
    'policy-loose/item.model.ts': projectionPolicyModelSource({ itemExact: true, containerExact: false }).text,
    'policy-exact/item.model.ts': projectionPolicyModelSource({ itemExact: false, containerExact: true }).text,
    'recursive/tree.model.ts': composition('recursive-projections-convert-every-selected-level-without-restoring-omitted', 'tree.model.ts'),
    'mapped-keys/item.model.ts': composition('mapped-key-renaming-preserves-nested-model-provenance-and-readonly-types', 'item.model.ts'),
    'dictionaries/item.model.ts': composition('dictionaries-and-tuple-rest-fields-construct-their-declared-nested-models', 'item.model.ts'),
    'root-intersections/item.model.ts': composition('root-intersections-remain-representable-object-contracts', 'item.model.ts'),
    'no-op-mapped/item.model.ts': composition('no-op-mapped-models-become-fresh-plain-objects-while-named-models-retain-ide', 'item.model.ts'),
    'identical-named/item.model.ts': composition('structurally-identical-named-models-keep-distinct-provenance-from-plain-obje', 'item.model.ts'),
    'intact-child/item.model.ts': composition('an-intact-child-model-keeps-its-own-allowany-policy-inside-a-strict-parent', 'item.model.ts'),
    'projected-child/item.model.ts': composition('a-projected-child-applies-the-containing-model-allowany-policy', 'item.model-2.ts'),
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const load = (directory: string, file: string) => import(path.join(root, 'build', directory, file));
  // Codec ids are read from the one directory's companion, since several directories declare a Container.
  const codecIdIn = (directory: string, shortName: string): string =>
    generatedCodecId(fs.readFileSync(path.join(sourceRoot, directory, 'item.model.generated.ts'), 'utf8'), shortName);

  await t.test('nested projections strip omitted fields and retain intact child models with validation=true', async () => {
    await assertNestedProjections(root, 'build/nested-projections/address.model.js', true);
  });

  await t.test('nested unions and selection utilities retain declaration identities', async () => {
    const { ContactBook, Email, Phone } = await load('nested-unions', 'contacts.model.js');
    const book = decodeGeneratedModel(ContactBook, { contact: { kind: 'phone', number: '123' }, selected: { kind: 'email', address: 'one' }, excluded: { kind: 'email', address: 'two' } });
    assert.ok(book.contact instanceof Phone);
    assert.ok(book.selected instanceof Email);
    assert.ok(book.excluded instanceof Email);
    assert.deepEqual(encodeGeneratedModel(book), { contact: { kind: 'phone', number: '123' }, selected: { kind: 'email', address: 'one' }, excluded: { kind: 'email', address: 'two' } });
  });

  for (const exact of [false, true]) {
    await t.test(`projection policy follows its containing model exact=${exact}`, async () => {
      const directory = exact ? 'policy-exact' : 'policy-loose';
      const { Container } = await load(directory, 'item.model.js');
      const input = { item: { id: 'extra', value: 'kept' } };
      if (exact) assert.throws(() => requireObjectCodec(codecIdIn(directory, 'Container')).assert( input));
      else assert.deepEqual((decodeGeneratedModel(Container, input)).item, { value: 'kept' });
      const unchecked = decodeGeneratedModel(Container, input);
      assert.deepEqual(unchecked.item, { value: 'kept' });
    });
  }

  await t.test('recursive projections convert every selected level without restoring omitted fields', async () => {
    const { Tree } = await load('recursive', 'tree.model.js');
    const tree = decodeGeneratedModel(Tree, { branch: { id: 'strip', label: 'one', children: [{ id: 'strip', label: 'two' }] } });
    assert.equal(Object.getPrototypeOf(tree.branch), Object.prototype);
    assert.equal(Object.getPrototypeOf(tree.branch.children[0]), Object.prototype);
    assert.deepEqual(encodeGeneratedModel(tree), { branch: { label: 'one', children: [{ label: 'two' }] } });
  });

  await t.test('mapped key renaming preserves nested model provenance and readonly types', async () => {
    const { Item, Residence } = await load('mapped-keys', 'item.model.js');
    const item = decodeGeneratedModel(Item, { contact: { copy_home: { city: 'Paris' } } });
    assert.ok(item.contact.copy_home instanceof Residence);
    assert.equal(Object.getPrototypeOf(item.contact), Object.prototype);
  });

  await t.test('dictionaries and tuple rest fields construct their declared nested models', async () => {
    const { Item, Venue } = await load('dictionaries', 'item.model.js');
    const item = decodeGeneratedModel(Item, { dictionary: { a: { town: 'Paris' } }, tuple: [{ town: 'Rome' }, { town: 'Lyon' }] });
    assert.ok(item.dictionary.a instanceof Venue);
    assert.ok(item.tuple[0] instanceof Venue);
    assert.ok(item.tuple[1] instanceof Venue);
    assert.deepEqual(encodeGeneratedModel(item), { dictionary: { a: { town: 'Paris' } }, tuple: [{ town: 'Rome' }, { town: 'Lyon' }] });
  });

  await t.test('root intersections remain representable object contracts', async () => {
    const { Item } = await load('root-intersections', 'item.model.js');
    const item = decodeGeneratedModel(Item, { id: 'one', count: 2, nested: { enabled: true } });
    assert.deepEqual({ ...item }, { id: 'one', count: 2, nested: { enabled: true } });
  });

  await t.test('no-op mapped models become fresh plain objects while named models retain identity', async () => {
    const { Place, Container } = await load('no-op-mapped', 'item.model.js');
    const address = new Place({ borough: 'Paris' });
    const container = decodeGeneratedModel(Container, { mapped: address, intact: address, plain: { borough: 'Rome' } });
    assert.equal(Object.getPrototypeOf(container.mapped), Object.prototype);
    assert.equal(Object.getPrototypeOf(container.plain), Object.prototype);
    assert.ok(container.intact instanceof Place);
    assert.notEqual(container.mapped, address);
    assert.deepEqual(encodeGeneratedModel(container), {
      mapped: { borough: 'Paris' },
      intact: { borough: 'Paris' },
      plain: { borough: 'Rome' },
    });
  });

  await t.test('structurally identical named models keep distinct provenance from plain objects', async () => {
    const { Alpha, Beta, Container } = await load('identical-named', 'item.model.js');
    const container = decodeGeneratedModel(Container, {
      alpha: { value: 'a' },
      beta: { value: 'b' },
      plain: { value: 'p' },
    });
    assert.ok(container.alpha instanceof Alpha);
    assert.ok(container.beta instanceof Beta);
    assert.equal(Object.getPrototypeOf(container.plain), Object.prototype);
    assert.equal(container.alpha instanceof Beta, false);
    assert.equal(container.beta instanceof Alpha, false);
  });

  await t.test('an intact child model keeps its own allowAny policy inside a strict parent', async () => {
    const { Child, Container } = await load('intact-child', 'item.model.js');
    const child = decodeGeneratedModel(Container, { child: { raw: () => 'allowed by child policy' } });
    assert.ok(child.child instanceof Child);
    assert.equal(typeof child.child.raw, 'function');
  });

  await t.test('a projected child applies the containing model allowAny policy', async () => {
    // The strict half is a diagnostic, so it generates in a project of its own.
    const strict = fixture(t);
    fs.writeFileSync(path.join(strict.sourceRoot, 'item.model.ts'), readFixture("models/model-composition/a-projected-child-applies-the-containing-model-allowany-policy/item.model.ts"));
    assert.throws(
      () => generate({ root: strict.root, profile: { mobx: false, validation: true } }),
      /RUNM1011.*contains any\. Replace it with a concrete type, or allow it with .*IModel<Fields, \{ allowAny: true \}>.*allowAny: true in golem\.yaml/,
    );
    const { Container } = await load('projected-child', 'item.model.js');
    const container = decodeGeneratedModel(Container, { child: { raw: () => 'allowed by containing policy' } });
    assert.equal(Object.getPrototypeOf(container.child), Object.prototype);
    assert.equal(typeof container.child.raw, 'function');
  });
});
