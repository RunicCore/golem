import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/codegen/conversion';
import { requireObjectCodec } from '@exprtlabs/codegen/serde';
import { generatedCodecIdFromRoot } from './packed/helpers.js';
import { compileModelProject, createModelProject } from './model-project.js';
import { discardedProjectionMetadataSource, projectionPolicyModelSource } from './fixture-templates/models/model-composition.js';
import { generate } from '#model/generator';

function fixture(t: TestContext, allowJs = false) {
  return createModelProject(t, {
    prefix: 'runic-model-composition-',
    name: 'model-composition',
    allowJs,
    ttscPlugin: true,
    linkWorkspaceNodeModules: true,
  });
}

test('an unrelated same-name class does not become a model constructor', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/an-unrelated-same-name-class-does-not-become-a-model-constructor/item.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: false } }).artifacts);
  await compileModelProject(root);
  const generated = await import(`${path.join(root, 'build/item.model.generated.js')}?${Date.now()}`);
  const authored = await import(`${path.join(root, 'build/item.model.js')}?${Date.now()}`);
  const parent = new generated.ParentBase({ child: { id: 'child' } });
  assert.ok(parent.child instanceof generated.ItemBase);
  assert.equal(parent.child instanceof authored.Item, false);
  assert.deepEqual(encodeGeneratedModel(parent), { child: { id: 'child' } });
});

test('first generation resolves model class bases through project path aliases', async t => {
  const { root, sourceRoot } = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', imports: { '#generated/*': './build/*.model.generated.js' } }));
  config.compilerOptions.paths = { '#generated/*': ['./src/*.model.generated.ts'] };
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases/item.model.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'parent.model.ts'), readFixture("models/model-composition/first-generation-resolves-model-class-bases-through-project-path-aliases/parent.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
  const generated = await import(`${path.join(root, 'build/parent.model.generated.js')}?${Date.now()}`);
  const authored = await import(path.join(root, 'build/item.model.js'));
  const parent = new generated.ParentBase({ child: { id: 'nested' } });
  assert.ok(parent.child instanceof authored.Item);
  assert.equal(parent.child.label, 'nested');
  assert.deepEqual(encodeGeneratedModel(parent), { child: { id: 'nested' } });
});


test('IModel exposes fields and rejects root unions before emitting artifacts', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'keys.ts'), readFixture("models/model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts/keys.ts"));
  await compileModelProject(root);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/imodel-exposes-fields-and-rejects-root-unions-before-emitting-artifacts/item.model.ts"));
  for (const validation of [true, false]) {
    assert.throws(() => generate({ root, profile: { mobx: false, validation } }), /RUNM1052.*Root IModel unions/);
  }
  assert.equal(fs.existsSync(path.join(sourceRoot, 'item.model.generated.ts')), false);
});

for (const validation of [false, true]) {
  test(`nested projections strip omitted fields and retain intact child models with validation=${validation}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'address.model.ts'), readFixture("models/model-composition/model-composition-address-model/address.model.ts"));
    writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation } }).artifacts);
    await compileModelProject(root);
    const { Address, Customer } = await import(path.join(root, 'build/address.model.js'));
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
    if (validation) assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'Customer')).assert( { ...input, address: { city: 'x' } }));
  });
}

test('nested unions and selection utilities retain declaration identities', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'contacts.model.ts'), readFixture("models/model-composition/nested-unions-and-selection-utilities-retain-declaration-identities/contacts.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { ContactBook, Email, Phone } = await import(path.join(root, 'build/contacts.model.js'));
  const book = decodeGeneratedModel(ContactBook, { contact: { kind: 'phone', number: '123' }, selected: { kind: 'email', address: 'one' }, excluded: { kind: 'email', address: 'two' } });
  assert.ok(book.contact instanceof Phone);
  assert.ok(book.selected instanceof Email);
  assert.ok(book.excluded instanceof Email);
  assert.deepEqual(encodeGeneratedModel(book), { contact: { kind: 'phone', number: '123' }, selected: { kind: 'email', address: 'one' }, excluded: { kind: 'email', address: 'two' } });
});

for (const exact of [false, true]) {
  test(`projection policy follows its containing model exact=${exact}`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), projectionPolicyModelSource({
      itemExact: !exact,
      containerExact: exact,
    }).text);
    writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
    await compileModelProject(root);
    const { Container } = await import(path.join(root, 'build/item.model.js'));
    const input = { item: { id: 'extra', value: 'kept' } };
    if (exact) assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'Container')).assert( input));
    else assert.deepEqual((decodeGeneratedModel(Container, input)).item, { value: 'kept' });
    const unchecked = decodeGeneratedModel(Container, input);
    assert.deepEqual(unchecked.item, { value: 'kept' });
  });
}

test('recursive projections convert every selected level without restoring omitted fields', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'tree.model.ts'), readFixture("models/model-composition/recursive-projections-convert-every-selected-level-without-restoring-omitted/tree.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { Tree } = await import(path.join(root, 'build/tree.model.js'));
  const tree = decodeGeneratedModel(Tree, { branch: { id: 'strip', label: 'one', children: [{ id: 'strip', label: 'two' }] } });
  assert.equal(Object.getPrototypeOf(tree.branch), Object.prototype);
  assert.equal(Object.getPrototypeOf(tree.branch.children[0]), Object.prototype);
  assert.deepEqual(encodeGeneratedModel(tree), { branch: { label: 'one', children: [{ label: 'two' }] } });
});

test('equivalent projections share helpers and execute only retained field codecs', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-composition/equivalent-projections-share-helpers-and-execute-only-retained-field-codecs/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/equivalent-projections-share-helpers-and-execute-only-retained-field-codecs/item.model.ts"));
  const result = generate({ root, profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  const companion = result.artifacts.find(artifact => artifact.path.endsWith('item.model.generated.ts'))!.content;
  assert.equal([...companion.matchAll(/function decodeItemOmitId\(/g)].length, 1);
  assert.equal([...companion.matchAll(/function initItemOmitId\(/g)].length, 1);
  assert.equal([...companion.matchAll(/function encodeItemOmitId\(/g)].length, 1);
  await compileModelProject(root);
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

test('mapped key renaming preserves nested model provenance and readonly types', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/mapped-key-renaming-preserves-nested-model-provenance-and-readonly-types/item.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { Item, Address } = await import(path.join(root, 'build/item.model.js'));
  const item = decodeGeneratedModel(Item, { contact: { copy_home: { city: 'Paris' } } });
  assert.ok(item.contact.copy_home instanceof Address);
  assert.equal(Object.getPrototypeOf(item.contact), Object.prototype);
});

test('dictionaries and tuple rest fields construct their declared nested models', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/dictionaries-and-tuple-rest-fields-construct-their-declared-nested-models/item.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { Item, Address } = await import(path.join(root, 'build/item.model.js'));
  const item = decodeGeneratedModel(Item, { dictionary: { a: { city: 'Paris' } }, tuple: [{ city: 'Rome' }, { city: 'Lyon' }] });
  assert.ok(item.dictionary.a instanceof Address);
  assert.ok(item.tuple[0] instanceof Address);
  assert.ok(item.tuple[1] instanceof Address);
  assert.deepEqual(encodeGeneratedModel(item), { dictionary: { a: { city: 'Paris' } }, tuple: [{ city: 'Rome' }, { city: 'Lyon' }] });
});

test('root intersections remain representable object contracts', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/root-intersections-remain-representable-object-contracts/item.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { Item } = await import(path.join(root, 'build/item.model.js'));
  const item = decodeGeneratedModel(Item, { id: 'one', count: 2, nested: { enabled: true } });
  assert.deepEqual({ ...item }, { id: 'one', count: 2, nested: { enabled: true } });
});

test('no-op mapped models become fresh plain objects while named models retain identity', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/no-op-mapped-models-become-fresh-plain-objects-while-named-models-retain-ide/item.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { Address, Container } = await import(path.join(root, 'build/item.model.js'));
  const address = new Address({ city: 'Paris' });
  const container = decodeGeneratedModel(Container, { mapped: address, intact: address, plain: { city: 'Rome' } });
  assert.equal(Object.getPrototypeOf(container.mapped), Object.prototype);
  assert.equal(Object.getPrototypeOf(container.plain), Object.prototype);
  assert.ok(container.intact instanceof Address);
  assert.notEqual(container.mapped, address);
  assert.deepEqual(encodeGeneratedModel(container), {
    mapped: { city: 'Paris' },
    intact: { city: 'Paris' },
    plain: { city: 'Rome' },
  });
});

test('structurally identical named models keep distinct provenance from plain objects', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/structurally-identical-named-models-keep-distinct-provenance-from-plain-obje/item.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { Alpha, Beta, Container } = await import(path.join(root, 'build/item.model.js'));
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

test('generated readonly fields remain readonly to TypeScript consumers', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/generated-readonly-fields-remain-readonly-to-typescript-consumers/item.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: false } }).artifacts);
  fs.writeFileSync(path.join(sourceRoot, 'readonly-consumer.ts'), readFixture("models/model-composition/generated-readonly-fields-remain-readonly-to-typescript-consumers/readonly-consumer.ts"));
  await compileModelProject(root);
});

test('anonymous nested IModel declarations fail with an actionable diagnostic', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/anonymous-nested-imodel-declarations-fail-with-an-actionable-diagnostic/item.model.ts"));
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    /RUNM1053.*named, exported declaration/,
  );
});

for (const tag of ['serde', 'validation'] as const) {
  test(`projection rejects discarded whole-object ${tag} metadata`, async t => {
    const { root, sourceRoot } = fixture(t);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), discardedProjectionMetadataSource({ metadata: tag }).text);
    assert.throws(
      () => generate({ root, profile: { mobx: false, validation: true } }),
      /RUNM1055.*whole-object constraints or serialization/,
    );
  });
}

test('an intact child model keeps its own allowAny policy inside a strict parent', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/an-intact-child-model-keeps-its-own-allowany-policy-inside-a-strict-parent/item.model.ts"));
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(root);
  const { Child, Container } = await import(path.join(root, 'build/item.model.js'));
  const child = decodeGeneratedModel(Container, { child: { raw: () => 'allowed by child policy' } });
  assert.ok(child.child instanceof Child);
  assert.equal(typeof child.child.raw, 'function');
});

test('a projected child applies the containing model allowAny policy', async t => {
  const strict = fixture(t);
  fs.writeFileSync(path.join(strict.sourceRoot, 'item.model.ts'), readFixture("models/model-composition/a-projected-child-applies-the-containing-model-allowany-policy/item.model.ts"));
  assert.throws(
    () => generate({ root: strict.root, profile: { mobx: false, validation: true } }),
    /RUNM1011.*contains any\. .*IModel<Fields, \{ allowAny: true \}>.*allowAny: true in runic-codegen\.yaml/,
  );

  const permissive = fixture(t);
  fs.writeFileSync(path.join(permissive.sourceRoot, 'item.model.ts'), readFixture("models/model-composition/a-projected-child-applies-the-containing-model-allowany-policy/item.model-2.ts"));
  writeGeneratedArtifacts(generate({ root: permissive.root, profile: { mobx: false, validation: true } }).artifacts);
  await compileModelProject(permissive.root);
  const { Container } = await import(path.join(permissive.root, 'build/item.model.js'));
  const container = decodeGeneratedModel(Container, { child: { raw: () => 'allowed by containing policy' } });
  assert.equal(Object.getPrototypeOf(container.child), Object.prototype);
  assert.equal(typeof container.child.raw, 'function');
});

test('generic model templates require a concrete named declaration', t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/generic-model-templates-require-a-concrete-named-declaration/item.model.ts"));
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /RUNM1057.*concrete fields/);
});

for (const ajvStandalone of [false, true]) {
  test(`MobX projections retain nested observability with standalone=${ajvStandalone}`, async t => {
    const { root, sourceRoot } = fixture(t, ajvStandalone);
    fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/model-composition-item-model/item.model.ts"));
    writeGeneratedArtifacts(generate({ root, profile: { mobx: true, validation: true, ajvStandalone } }).artifacts);
    await compileModelProject(root);
    const { Parent, Child } = await import(path.join(root, 'build/item.model.js'));
    const { autorun, isObservableObject, runInAction } = await import('mobx');
    const parent = decodeGeneratedModel(Parent, { projected: { child: { name: 'First' } } });
    assert.ok(parent.projected.child instanceof Child);
    assert.equal(Object.getPrototypeOf(parent.projected), Object.prototype);
    assert.ok(isObservableObject(parent.projected.child));
    const seen: string[] = [];
    const dispose = autorun(() => { seen.push(parent.projected.child.name); });
    try {
      runInAction(() => { parent.projected.child.name = 'Next'; });
      assert.deepEqual(seen, ['First', 'Next']);
      assert.deepEqual(encodeGeneratedModel(parent), { projected: { child: { name: 'Next' } } });
      runInAction(() => { parent.projected.child.name = 'x'; });
      assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'Parent')).assert( encodeGeneratedModel(parent)));
    } finally { dispose(); }
  });
}
