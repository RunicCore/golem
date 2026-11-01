import { generate as generateOpenApi } from '@exprtlabs/golem-openapi-ts/generator';
import { readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { requireObjectCodec, decodeGeneratedModelTrusted } from '@exprtlabs/golem/internal/model-runtime';
import { generatedCodecId, generatedCodecIdFromRoot } from './support/consumer.js';
import { compositionProject as fixture } from './support/model-composition-project.js';
import { buildModelProject, createModelProject, generatedModelFiles, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { projectionPolicyModelSource } from './fixture-templates/models/model-composition.js';
import { generate } from '#model/generator';
import { modelCodec } from './support/model-codec.js';

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
  const wire = modelCodec(customer).toWireFormat(customer) as { address: unknown };
  assert.deepEqual(wire.address, { city: 'Paris' });
  const input = { address: { id: 'strip', city: 'Paris' }, delivery: {}, intact: { id: 'keep', city: 'Paris' }, readonlyAddress: { id: 'ok', city: 'Paris' } };
  const decoded = modelCodec(Customer).fromWireFormat(input, { validate: false });
  assert.deepEqual(decoded.address, { city: 'Paris' });
  assert.ok(decoded.intact instanceof Address);
  assert.equal(input.address.id, 'strip');
  if (validation) assert.throws(() => requireObjectCodec(generatedCodecIdFromRoot(root, 'TCustomer')).assert( { ...input, address: { city: 'x' } }));
}

/** Build the shared project with the Place model, whose Office model projects it without the id. */
async function buildPlaceProject(t: TestContext): Promise<string> {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'place.model.ts'), readFixture("models/model-composition/projection-decoders-copy-fields-with-assignments/place.model.ts"));
  writeModelGolemYaml(root, { validation: false });
  await buildModelProject(root);
  return root;
}

test('nested projections strip omitted fields and retain intact child models with validation=false', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'address.model.ts'), readFixture("models/model-composition/model-composition-address-model/address.model.ts"));
  writeModelGolemYaml(root, { validation: false });
  await buildModelProject(root);
  await assertNestedProjections(root, 'build/address.model.js', false);
});

test('projection decoders copy fields with assignments and keep the prototype untouched', async t => {
  const root = await buildPlaceProject(t);
  const companion = generatedModelFiles(root).find(artifact => artifact.path.endsWith('place.model.generated.ts'))!.content;
  const helper = companion.split('\n').find(line => line.startsWith('function decodeTPlaceOmitId('));
  assert.ok(helper);
  assert.doesNotMatch(helper, /Object\.fromEntries/);
  const { Office } = await import(path.join(root, 'build/place.model.js'));
  const place = JSON.parse('{"city":"Hue","country":"VN","__proto__":{"x":1}}');
  const office = modelCodec(Office).fromWireFormat({ place }, { validate: false }) as { place: Record<string, unknown> };
  assert.equal(Object.getPrototypeOf(office.place), Object.prototype);
  assert.deepEqual(office.place, { city: 'Hue', country: 'VN' });
  assert.deepEqual(modelCodec(office).toWireFormat(office), { place: { city: 'Hue', country: 'VN' } });
});

test('a projection decoder leaves out a field that is undefined or not enumerable in the input', async t => {
  // The projection decoder is the model's own decode hook, which the codec's fromWireFormat does not run; decodeGeneratedModelTrusted is its caller in generated code.
  const { Office } = await import(path.join(await buildPlaceProject(t), 'build/place.model.js'));
  const hidden = Object.defineProperty({ city: 'Hue' }, 'country', { value: 'VN', enumerable: false });
  assert.deepEqual(Object.keys(decodeGeneratedModelTrusted(Office, { place: { city: 'Hue', country: undefined } }).place), ['city']);
  assert.deepEqual(Object.keys(decodeGeneratedModelTrusted(Office, { place: hidden }).place), ['city']);
});

test('a projection decoder leaves out an undeclared key whose value is undefined', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'board.model.ts'), readFixture("models/model-composition/projection-extras/board.model.ts"));
  writeModelGolemYaml(root, { validation: false });
  await buildModelProject(root);
  const { Board } = await import(path.join(root, 'build/board.model.js'));
  const board = modelCodec(Board).fromWireFormat({ slots: { x: undefined, y: { at: '2026-01-02T00:00:00.000Z' } } }, { validate: false });
  assert.deepEqual(Object.keys(board.slots), ['y']);
  assert.ok(board.slots.y.at instanceof Date);
});

test('equivalent projections share helpers and execute only retained field codecs', async t => {
  const { root, sourceRoot } = fixture(t);
  fs.writeFileSync(path.join(sourceRoot, 'codecs.ts'), readFixture("models/model-composition/equivalent-projections-share-helpers-and-execute-only-retained-field-codecs/codecs.ts"));
  fs.writeFileSync(path.join(sourceRoot, 'item.model.ts'), readFixture("models/model-composition/equivalent-projections-share-helpers-and-execute-only-retained-field-codecs/item.model.ts"));
  writeModelGolemYaml(root, { validation: false });
  await buildModelProject(root);
  const companion = generatedModelFiles(root).find(artifact => artifact.path.endsWith('item.model.generated.ts'))!.content;
  assert.equal([...companion.matchAll(/function decodeTItemOmitId\(/g)].length, 1);
  assert.equal([...companion.matchAll(/function initTItemOmitId\(/g)].length, 1);
  const { Container } = await import(path.join(root, 'build/item.model.js'));
  const codecs = await import(path.join(root, 'build/codecs.js'));
  const model = modelCodec(Container).fromWireFormat({ first: { id: 'ignored', value: 'HELLO' } }, { validate: false });
  assert.deepEqual(model.first, { value: 'hello' });
  assert.equal(codecs.retained, 1);
  assert.equal(codecs.removed, 0);
  assert.deepEqual(modelCodec(model).toWireFormat(model), { first: { value: 'HELLO' } });
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
  writeModelGolemYaml(root, { validation: true });
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
    const book = modelCodec(ContactBook).fromWireFormat({ contact: { kind: 'phone', number: '123' }, selected: { kind: 'email', address: 'one' }, excluded: { kind: 'email', address: 'two' } }, { validate: false });
    assert.ok(book.contact instanceof Phone);
    assert.ok(book.selected instanceof Email);
    assert.ok(book.excluded instanceof Email);
    assert.deepEqual(modelCodec(book).toWireFormat(book), { contact: { kind: 'phone', number: '123' }, selected: { kind: 'email', address: 'one' }, excluded: { kind: 'email', address: 'two' } });
  });

  for (const exact of [false, true]) {
    await t.test(`projection policy follows its containing model exact=${exact}`, async () => {
      const directory = exact ? 'policy-exact' : 'policy-loose';
      const { Container } = await load(directory, 'item.model.js');
      const input = { item: { id: 'extra', value: 'kept' } };
      if (exact) assert.throws(() => requireObjectCodec(codecIdIn(directory, 'Container')).assert( input));
      else assert.deepEqual((modelCodec(Container).fromWireFormat(input, { validate: false })).item, { value: 'kept' });
      const unchecked = modelCodec(Container).fromWireFormat(input, { validate: false });
      assert.deepEqual(unchecked.item, { value: 'kept' });
    });
  }

  await t.test('recursive projections convert every selected level without restoring omitted fields', async () => {
    const { Tree } = await load('recursive', 'tree.model.js');
    const tree = modelCodec(Tree).fromWireFormat({ branch: { id: 'strip', label: 'one', children: [{ id: 'strip', label: 'two' }] } }, { validate: false });
    assert.equal(Object.getPrototypeOf(tree.branch), Object.prototype);
    assert.equal(Object.getPrototypeOf(tree.branch.children[0]), Object.prototype);
    assert.deepEqual(modelCodec(tree).toWireFormat(tree), { branch: { label: 'one', children: [{ label: 'two' }] } });
  });

  await t.test('mapped key renaming preserves nested model provenance and readonly types', async () => {
    const { Item, Residence } = await load('mapped-keys', 'item.model.js');
    const item = modelCodec(Item).fromWireFormat({ contact: { copy_home: { city: 'Paris' } } }, { validate: false });
    assert.ok(item.contact.copy_home instanceof Residence);
    assert.equal(Object.getPrototypeOf(item.contact), Object.prototype);
  });

  await t.test('dictionaries and tuple rest fields construct their declared nested models', async () => {
    const { Item, Venue } = await load('dictionaries', 'item.model.js');
    const item = modelCodec(Item).fromWireFormat({ dictionary: { a: { town: 'Paris' } }, tuple: [{ town: 'Rome' }, { town: 'Lyon' }] }, { validate: false });
    assert.ok(item.dictionary.a instanceof Venue);
    assert.ok(item.tuple[0] instanceof Venue);
    assert.ok(item.tuple[1] instanceof Venue);
    assert.deepEqual(modelCodec(item).toWireFormat(item), { dictionary: { a: { town: 'Paris' } }, tuple: [{ town: 'Rome' }, { town: 'Lyon' }] });
  });

  await t.test('root intersections remain representable object contracts', async () => {
    const { Item } = await load('root-intersections', 'item.model.js');
    const item = modelCodec(Item).fromWireFormat({ id: 'one', count: 2, nested: { enabled: true } }, { validate: false });
    assert.deepEqual({ ...item }, { id: 'one', count: 2, nested: { enabled: true } });
  });

  await t.test('no-op mapped models become fresh plain objects while named models retain identity', async () => {
    const { Place, Container } = await load('no-op-mapped', 'item.model.js');
    const address = new Place({ borough: 'Paris' });
    const container = modelCodec(Container).fromWireFormat({ mapped: address, intact: address, plain: { borough: 'Rome' } }, { validate: false });
    assert.equal(Object.getPrototypeOf(container.mapped), Object.prototype);
    assert.equal(Object.getPrototypeOf(container.plain), Object.prototype);
    assert.ok(container.intact instanceof Place);
    assert.notEqual(container.mapped, address);
    assert.deepEqual(modelCodec(container).toWireFormat(container), {
      mapped: { borough: 'Paris' },
      intact: { borough: 'Paris' },
      plain: { borough: 'Rome' },
    });
  });

  await t.test('structurally identical named models keep distinct provenance from plain objects', async () => {
    const { Alpha, Beta, Container } = await load('identical-named', 'item.model.js');
    const container = modelCodec(Container).fromWireFormat({
      alpha: { value: 'a' },
      beta: { value: 'b' },
      plain: { value: 'p' },
    }, { validate: false });
    assert.ok(container.alpha instanceof Alpha);
    assert.ok(container.beta instanceof Beta);
    assert.equal(Object.getPrototypeOf(container.plain), Object.prototype);
    assert.equal(container.alpha instanceof Beta, false);
    assert.equal(container.beta instanceof Alpha, false);
  });

  await t.test('an intact child model keeps its own allowAny policy inside a strict parent', async () => {
    const { Child, Container } = await load('intact-child', 'item.model.js');
    const child = modelCodec(Container).fromWireFormat({ child: { raw: () => 'allowed by child policy' } }, { validate: false });
    assert.ok(child.child instanceof Child);
    assert.equal(typeof child.child.raw, 'function');
  });

  await t.test('a projected child applies the containing model allowAny policy', async () => {
    // The strict half is a diagnostic, so it generates in a project of its own.
    const strict = fixture(t);
    fs.writeFileSync(path.join(strict.sourceRoot, 'item.model.ts'), readFixture("models/model-composition/a-projected-child-applies-the-containing-model-allowany-policy/item.model.ts"));
    assert.throws(
      () => generate({ root: strict.root, profile: { validation: true } }),
      /RUNM1011.*contains any\. Replace it with a concrete type, or allow it with .*IModel<Fields, \{ allowAny: true \}>.*allowAny: true in golem\.yaml/,
    );
    const { Container } = await load('projected-child', 'item.model.js');
    const container = modelCodec(Container).fromWireFormat({ child: { raw: () => 'allowed by containing policy' } }, { validate: false });
    assert.equal(Object.getPrototypeOf(container.child), Object.prototype);
    assert.equal(typeof container.child.raw, 'function');
  });
});

/** A project with an SDK of one model, `Envelope`, whose `payload` property has no type; `writeView` writes a model file with one field of the given type. */
async function envelopeSdkProject(t: TestContext) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sdk-envelope-', name: 'sdk-envelope', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'envelope.yaml'), `openapi: 3.1.0
info: { title: Envelopes, version: "1" }
paths:
  /envelopes:
    get:
      operationId: getEnvelope
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Envelope" }
components:
  schemas:
    Envelope:
      type: object
      additionalProperties: false
      required: [id, payload]
      properties:
        id: { type: string }
        payload: { description: Any JSON value }
`);
  writeGeneratedArtifacts((await generateOpenApi({
    input: path.join(sourceRoot, 'envelope.yaml'),
    output: path.join(sourceRoot, 'sdk'),
    name: 'Envelopes',
    profile: { validation: true },
  })).artifacts);
  writeModelGolemYaml(root, { validation: true });
  const writeView = (field: string, options = ''): void => writeModelSources(sourceRoot, {
    'view.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Envelope } from './sdk/index.js';
import { TViewBaseModel } from './view.model.generated.js';
export type TView = IModel<{ envelope: ${field} }${options}>;
export class View extends TViewBaseModel {}
`,
  });
  return { root, writeView };
}

test('a model that references an SDK type with an untyped property is rejected by default and allowed by allowAny', async t => {
  // protects: F-176 the SDK type is a plain type, so its unknown property is an unknown position of the model
  const { root, writeView } = await envelopeSdkProject(t);
  writeView('Envelope');
  const rejected = await buildModelProject(root, [], { allowFailure: true });
  assert.notEqual(rejected.code, 0);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /RUNM1011.*contains unknown/);
  writeView('Envelope', ', { allowAny: true }');
  const allowed = await buildModelProject(root, [], { allowFailure: true });
  assert.equal(allowed.code, 0, `${allowed.stdout}\n${allowed.stderr}`);
});

test('a model that projects an SDK model with an unknown field is rejected by default and allowed by allowAny', async t => {
  const { root, writeView } = await envelopeSdkProject(t);
  writeView("Pick<Envelope, 'id' | 'payload'>");
  const rejected = await buildModelProject(root, [], { allowFailure: true });
  assert.notEqual(rejected.code, 0);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /RUNM1011.*contains unknown/);
  writeView("Pick<Envelope, 'id' | 'payload'>", ', { allowAny: true }');
  const allowed = await buildModelProject(root, [], { allowFailure: true });
  assert.equal(allowed.code, 0, `${allowed.stdout}\n${allowed.stderr}`);
});

test('a projection over a source object drops the brand keys of an SDK model and keeps a field spelled like one', async t => {
  // protects: F-213 a generated-model brand key is found by its symbol, so a string key spelled like one stays a field
  const { root, writeView } = await envelopeSdkProject(t);
  writeView('Omit<Envelope, \'payload\'>');
  const built = await buildModelProject(root, [], { allowFailure: true });
  assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
  const companion = generatedModelFiles(root).find(artifact => artifact.path.endsWith('view.model.generated.ts'))!.content;
  assert.doesNotMatch(companion, /__@/);
});

test('a projection keeps a source field whose string key is spelled like a brand key', async t => {
  // protects: F-213 a generated-model brand key is found by its symbol, so a string key spelled like one stays a field
  const { root, sourceRoot } = fixture(t);
  writeModelGolemYaml(root, { validation: true });
  writeModelSources(sourceRoot, {
    'view.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TViewBaseModel } from './view.model.generated.js';
export interface Look { name: string; '__@generatedModelWireBrand@1': string; extra: string }
export type TView = IModel<{ look: Omit<Look, 'extra'> }>;
export class View extends TViewBaseModel {}
`,
  });
  await buildModelProject(root);
  const { View } = await import(path.join(root, 'build/view.model.js'));
  const wire = modelCodec(View).toWireFormat(modelCodec(View).fromWireFormat({ look: { name: 'a', '__@generatedModelWireBrand@1': 'b', extra: 'c' } }, { validate: false }));
  assert.deepEqual(wire, { look: { name: 'a', '__@generatedModelWireBrand@1': 'b' } });
});

test('an indexed access to an anonymous field of a model stays a plain object, not an instance of an unrelated model with the same fields', async t => {
  // protects: bug sweep 3 TOrder['shipping'] kept TOrder as its model, so the structural match bound the field to TAddress
  const { root, sourceRoot } = fixture(t);
  writeModelGolemYaml(root, { validation: false });
  writeModelSources(sourceRoot, {
    'invoice.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TAddressBaseModel, TInvoiceBaseModel, TOrderBaseModel } from './invoice.model.generated.js';
export type TOrder = IModel<{ shipping: { street: string; city: string } }>;
export type TAddress = IModel<{ street: string; city: string }>;
export type TInvoice = IModel<{ billing: TOrder['shipping']; picked: Pick<TOrder, 'shipping'>['shipping']; inline: { street: string; city: string } }>;
export class Order extends TOrderBaseModel {}
export class Address extends TAddressBaseModel {}
export class Invoice extends TInvoiceBaseModel {}
`,
  });
  await buildModelProject(root);
  const { Invoice, Address } = await import(path.join(root, 'build/invoice.model.js'));
  const wire = { billing: { street: 's', city: 'c' }, picked: { street: 's', city: 'c' }, inline: { street: 's', city: 'c' } };
  const invoice = modelCodec(Invoice).fromWireFormat(wire, { validate: false });
  assert.equal(invoice.inline instanceof Address, false, 'the inline spelling');
  assert.equal(invoice.billing instanceof Address, false, 'the indexed access');
  assert.equal(invoice.picked instanceof Address, false, 'the indexed access of a projection');
  assert.equal(Object.getPrototypeOf(invoice.billing), Object.prototype);
  assert.deepEqual(modelCodec(invoice).toWireFormat(invoice), wire);
});
