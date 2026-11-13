// lane: typescript6 The generated strip plans, which hold a typed Map of tag variants, compile with the TypeScript 6 shim
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import type { DecodeOptions, EncodeOptions } from '@exprtlabs/golem/serde';

import { readFixture } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { chargesDocument, loadGolemModeProject, loadSdk, type GolemModeSdkSetup } from './openapi/sdk-client-fixture.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';

// `strip: true` on one decode or encode call removes the keys that a closed object does not declare, at every level (R-65 G2).
// The default is unchanged: an extra key of a closed object fails validation.

type Model = new (values?: object) => object;
const strip = { strip: true } as const;
const isValidationError = (error: unknown): error is LibError => error instanceof LibError && error.kind === LibErrorKind.Validation;

async function buildModels(t: TestContext) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-decode-strip-', name: 'decode-strip', linkWorkspaceNodeModules: true });
  for (const file of ['strip.model.ts', 'units.ts']) fs.writeFileSync(path.join(sourceRoot, file), readFixture(`models/decode-strip/strip/${file}`));
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const models = await import(pathToFileURL(path.join(root, 'build/strip.model.js')).href);
  const codec = (name: string) => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  return {
    Card: models.Card as Model, Ledger: models.Ledger as Model, PatternLedger: models.PatternLedger as Model, Registry: models.Registry as Model, Shelf: models.Shelf as Model, PetHolder: models.PetHolder as Model, Tree: models.Tree as Model, Tally: models.Tally as Model, Tagged: models.Tagged as Model, TaggedOpen: models.TaggedOpen as Model,
    plain: codec('TPlain'), nested: codec('TNested'), open: codec('TOpen'), mapHolder: codec('TMapHolder'), patterned: codec('TPatterned'), nullable: codec('TNullable'), tagged: codec('TTagged'), patternItems: codec('TPatternItems'), tagTypes: codec('TTagTypes'), tagProto: codec('TTagProto'), taggedOpen: codec('TTaggedOpen'), priced: codec('TPriced'),
    card: codec('TCard'), ledger: codec('TLedger'), patternLedger: codec('TPatternLedger'), registry: codec('TRegistry'), shelf: codec('TShelf'), petHolder: codec('TPetHolder'), tree: codec('TTree'), tally: codec('TTally'),
  };
}

/** The value at `path` of `value`. */
function at(value: unknown, ...path: (string | number)[]): object {
  return path.reduce<unknown>((current, key) => (current as Record<string | number, unknown>)[key], value) as object;
}

const sorted = (value: object) => Object.keys(value).sort();

test('strip on decode', async (t) => {
  const m = await buildModels(t);
  const levels = [true, 'sanity', false] as const;
  const options = (level: boolean | 'sanity', extra: DecodeOptions = {}): DecodeOptions => ({ ...strip, validate: level, ...extra });

  await t.test('every path keeps the declared keys only, at each validation level', () => {
    // protects: R-65 G2 a class result, a plain result, a nested class, an array of class, a tagged union and a recursive model hold the declared keys only
    const card = { title: 'a', count: 1, extra: 1 };
    const rows: ReadonlyArray<readonly [string, () => unknown, readonly (readonly [(string | number)[], string[]])[]]> = levels.flatMap((level) => [
      [`plain object, validate ${level}`, () => m.plain.fromWireFormat({ title: 'a', count: 1, extra: 1 }, options(level)), [[[], ['count', 'title']]]],
      [`class, validate ${level}`, () => m.card.fromWireFormat(card, options(level, { construct: m.Card })), [[[], ['count', 'title']]]],
      [`nested plain objects, validate ${level}`, () => m.nested.fromWireFormat({ inner: { title: 'a', x: 1 }, list: [{ title: 'b', y: 2 }], z: 3 }, options(level)), [[[], ['inner', 'list']], [['inner'], ['title']], [['list', 0], ['title']]]],
      [`nested class and array of class, validate ${level}`, () => m.shelf.fromWireFormat({ cards: [{ title: 'a', x: 1 }], main: { title: 'b', y: 2 }, z: 3 }, options(level, { construct: m.Shelf })), [[[], ['cards', 'main']], [['cards', 0], ['title']], [['main'], ['title']]]],
      [`tagged union, validate ${level}`, () => m.petHolder.fromWireFormat({ pet: { kind: 'cat', lives: 9, junk: 1 }, extra: 1 }, options(level, { construct: m.PetHolder })), [[[], ['pet']], [['pet'], ['kind', 'lives']]]],
      [`nullable single object variant, validate ${level}`, () => m.nullable.fromWireFormat({ child: { title: 'a', x: 1 } }, options(level)), [[['child'], ['title']]]],
      [`tagged union with a default variant: no tag goes to the default, validate ${level}`, () => m.tagged.fromWireFormat({ item: { amount: 1, junk: 1 } }, options(level, { construct: m.Tagged })), [[['item'], ['amount']]]],
      [`tagged union with a default variant: a known tag, validate ${level}`, () => m.tagged.fromWireFormat({ item: { kind: 'other', value: 1, junk: 1 } }, options(level, { construct: m.Tagged })), [[['item'], ['kind', 'value']]]],
      [`tagged union whose default variant is closed and whose other variant is open: the open variant keeps its keys, validate ${level}`, () => m.taggedOpen.fromWireFormat({ item: { kind: 'open', value: 1, extra: 1 } }, options(level, { construct: m.TaggedOpen })), [[['item'], ['extra', 'kind', 'value']]]],
      [`tagged union whose default variant is closed and whose other variant is open: the default variant is stripped, validate ${level}`, () => m.taggedOpen.fromWireFormat({ item: { amount: 1, junk: 1 } }, options(level, { construct: m.TaggedOpen })), [[['item'], ['amount']]]],
      [`recursive model, validate ${level}`, () => m.tree.fromWireFormat({ name: 'a', junk: 1, kids: [{ name: 'b', junk: 2, kids: [{ name: 'c', junk: 3 }] }] }, options(level, { construct: m.Tree })), [[[], ['kids', 'name']], [['kids', 0], ['kids', 'name']], [['kids', 0, 'kids', 0], ['name']]]],
    ] as const);
    for (const [name, decode, expectations] of rows) {
      const result = decode();
      for (const [where, keys] of expectations) assert.deepEqual(sorted(at(result, ...where)), keys, `${name} at ${where.join('.') || 'root'}`);
    }
  });

  await t.test('a class result is the model class and its nested values are the nested class', () => {
    // protects: R-65 G2 strip changes the keys of a result, not its class
    const shelf = m.shelf.fromWireFormat({ cards: [{ title: 'a', x: 1 }], main: { title: 'b' } }, { ...strip, construct: m.Shelf });
    assert.ok(shelf instanceof m.Shelf);
    assert.ok(at(shelf, 'main') instanceof m.Card);
    assert.ok(at(shelf, 'cards', 0) instanceof m.Card);
  });

  await t.test('parse strips the same keys from JSON text', () => {
    // protects: R-65 G2 parse takes the option as fromWireFormat does
    const result = m.nested.parse('{"inner":{"title":"a","x":1},"list":[{"title":"b","y":2}],"z":3}', strip);
    assert.deepEqual(sorted(result as object), ['inner', 'list']);
    assert.deepEqual(sorted(at(result, 'inner')), ['title']);
    assert.deepEqual(sorted(at(result, 'list', 0)), ['title']);
  });

  await t.test('data that a model declares as extra stays: an open model, a map, an index signature and pattern properties', () => {
    // protects: R-65 G2 strip never removes declared extra data
    assert.deepEqual(sorted(m.open.fromWireFormat({ title: 'a', extra: 1 }, strip) as object), ['extra', 'title']);
    const mapped = m.mapHolder.fromWireFormat({ tags: { a: { title: 'x', junk: 1 }, b: { title: 'y' } } }, strip);
    assert.deepEqual(sorted(at(mapped, 'tags')), ['a', 'b']);
    assert.deepEqual(sorted(at(mapped, 'tags', 'a')), ['title'], 'a closed value of the map is stripped');
    assert.deepEqual(sorted(m.tally.fromWireFormat({ id: 'a', anything: 'x' }, { ...strip, construct: m.Tally }) as object), ['anything', 'id']);
    assert.deepEqual(sorted(m.patterned.fromWireFormat({ known: 'a', x_1: 1, junk: 2 }, strip) as object), ['known', 'x_1']);
  });

  await t.test('a key that a pattern declares holds a closed object that is stripped', () => {
    // protects: T-896 a pattern property whose schema is a closed object loses its undeclared keys on decode
    const decoded = m.patternItems.fromWireFormat({ known: 'a', x_item: { name: 'n', extra: 1 }, junk: 2 }, strip);
    assert.deepEqual(decoded, { known: 'a', x_item: { name: 'n' } });
  });

  await t.test('a tag of a number and a tag of the same text select their own variant', () => {
    // protects: T-896 the tag 1 and the tag '1' do not share one plan
    assert.deepEqual(m.tagTypes.fromWireFormat({ item: { kind: 1, a: 1, junk: 1 } }, strip), { item: { kind: 1, a: 1 } });
    assert.deepEqual(m.tagTypes.fromWireFormat({ item: { kind: '1', b: 1, junk: 1 } }, strip), { item: { kind: '1', b: 1 } });
  });

  await t.test('a tag called __proto__ selects its variant', () => {
    // protects: T-896 a tag value that an object literal cannot hold as a key still has its plan
    assert.deepEqual(m.tagProto.fromWireFormat({ item: { kind: '__proto__', a: 1, junk: 1 } }, strip), { item: { kind: '__proto__', a: 1 } });
    assert.deepEqual(m.tagProto.fromWireFormat({ item: { kind: 'plain', b: 1, junk: 1 } }, strip), { item: { kind: 'plain', b: 1 } });
  });

  await t.test('a declared key with a bad value still reports, and without the option an extra key still fails', () => {
    // protects: R-65 G2 errors on declared keys are as before; the default decode is unchanged
    assert.throws(
      () => m.plain.fromWireFormat({ title: 5, extra: 1 }, strip),
      (error: unknown) => isValidationError(error) && error.issues.map((issue) => issue.path.join('.')).join() === 'title',
    );
    assert.throws(
      () => m.plain.fromWireFormat({ title: 'a', extra: 1 }),
      (error: unknown) => isValidationError(error) && error.issues.map((issue) => issue.path.join('.')).join() === 'extra',
    );
  });

  await t.test('the input is not changed', () => {
    // protects: R-65 G2 strip copies what it changes and never writes to the wire
    const wire = { inner: { title: 'a', x: 1 }, list: [{ title: 'b', y: 2 }], z: 3 };
    m.nested.fromWireFormat(wire, strip);
    assert.deepEqual(wire, { inner: { title: 'a', x: 1 }, list: [{ title: 'b', y: 2 }], z: 3 });
  });
});

test('strip on encode', async (t) => {
  const m = await buildModels(t);
  const levels = [true, 'sanity', false] as const;
  const options = (level: boolean | 'sanity'): EncodeOptions => ({ ...strip, validate: level });
  const row = { title: 'a', count: 1, extra: 1 };

  for (const level of levels) {
    await t.test(`an exact model drops a key it does not declare, validate ${level}`, () => {
      // protects: T-896 a handler that returns a database row with an extra column encodes it
      assert.deepEqual(m.plain.toWireFormat(row, options(level)), { title: 'a', count: 1 });
      assert.deepEqual(JSON.parse(m.plain.stringify(row, options(level))), { title: 'a', count: 1 });
    });

    await t.test(`a nested exact model, an array of them, a map value and a tagged union drop their extra keys, validate ${level}`, () => {
      // protects: T-896 strip on encode reaches every level, as on decode
      const nested = m.nested.toWireFormat({ inner: { title: 'a', x: 1 }, list: [{ title: 'b', y: 2 }], z: 3 }, options(level));
      assert.deepEqual(nested, { inner: { title: 'a' }, list: [{ title: 'b' }] });
      assert.deepEqual(m.mapHolder.toWireFormat({ tags: { a: { title: 'x', junk: 1 } } }, options(level)), { tags: { a: { title: 'x' } } });
      assert.deepEqual(m.petHolder.toWireFormat({ pet: { kind: 'cat', lives: 9, junk: 1 }, extra: 1 }, options(level)), { pet: { kind: 'cat', lives: 9 } });
    });

    await t.test(`the data that a model declares as extra stays, and an open variant of a tagged union keeps its tag and value, validate ${level}`, () => {
      // protects: T-896 strip on encode keeps declared extra data, and a variant without a plan is not given to the default variant
      assert.deepEqual(m.tally.toWireFormat({ id: 'a', anything: 'x' }, options(level)), { id: 'a', anything: 'x' });
      assert.deepEqual(m.patterned.toWireFormat({ known: 'a', x_1: 1, junk: 2 }, options(level)), m.patterned.toWireFormat({ known: 'a', x_1: 1 }, { validate: level }));
      const open = { item: { kind: 'open', value: 1, extra: 1 } };
      assert.deepEqual(m.taggedOpen.toWireFormat(open, options(level)), m.taggedOpen.toWireFormat(open, { validate: level }));
      assert.equal((m.taggedOpen.toWireFormat(open, options(level)) as { item: { kind: string } }).item.kind, 'open');
    });

    await t.test(`an instance of a class and its nested instances encode the declared fields, validate ${level}`, () => {
      // protects: T-896 strip on encode leaves a class instance to the encoder, which writes its declared fields
      const card = new m.Card({ title: 'a' });
      Object.assign(card, { program: 'state' });
      assert.deepEqual(m.card.toWireFormat(card, options(level)), { title: 'a' });
      assert.deepEqual(m.shelf.toWireFormat(new m.Shelf({ cards: [new m.Card({ title: 'b' })], main: card }), options(level)), { cards: [{ title: 'b' }], main: { title: 'a' } });
    });

    await t.test(`an instance of a class that holds plain objects with extra keys drops them, validate ${level}`, () => {
      // protects: T-896 a handler that returns a model class that holds a database row encodes it
      const holder = new m.PetHolder({ pet: { kind: 'cat', lives: 9, junk: 1 } });
      Object.assign(holder, { program: 'state' });
      assert.deepEqual(m.petHolder.toWireFormat(holder, options(level)), { pet: { kind: 'cat', lives: 9 } });
      assert.deepEqual(JSON.parse(m.petHolder.stringify(holder, options(level))), { pet: { kind: 'cat', lives: 9 } });
      assert.deepEqual(m.tagged.toWireFormat(new m.Tagged({ item: { kind: 'other', value: 1, junk: 1 } }), options(level)), { item: { kind: 'other', value: 1 } });
      assert.deepEqual(m.tagged.toWireFormat(new m.Tagged({ item: { amount: 1, junk: 1 } }), options(level)), { item: { amount: 1 } });
      assert.deepEqual(m.shelf.toWireFormat(new m.Shelf({ cards: [], main: new m.Card({ title: 'a' }) }), options(level)), { cards: [], main: { title: 'a' } });
    });

    await t.test(`an instance of an open model strips the closed objects that its other keys hold, validate ${level}`, () => {
      // protects: T-896 the other keys of an instance of a model with AdditionalProperties or an index signature are map data, which the encoder writes and strip walks
      const ledger = Object.assign(new m.Ledger({ id: 'a' }), { one: { name: 'n', extra: 1 }, two: { name: 'm' } });
      assert.deepEqual(m.ledger.toWireFormat(ledger, options(level)), { id: 'a', one: { name: 'n' }, two: { name: 'm' } });
      assert.deepEqual(JSON.parse(m.ledger.stringify(ledger, options(level))), { id: 'a', one: { name: 'n' }, two: { name: 'm' } });
      assert.deepEqual((ledger as { one: unknown }).one, { name: 'n', extra: 1 }, 'the instance is not changed');
      const registry = Object.assign(new m.Registry(), { one: { name: 'n', extra: 1 } });
      assert.deepEqual(m.registry.toWireFormat(registry, options(level)), { one: { name: 'n' } });
      assert.deepEqual(JSON.parse(m.registry.stringify(registry, options(level))), { one: { name: 'n' } });
    });

    await t.test(`a frozen instance of an open model strips the closed objects that its other keys hold, validate ${level}`, () => {
      // protects: T-896 the copy of an instance takes a changed map entry in its own descriptor
      const ledger = Object.freeze(Object.assign(new m.Ledger({ id: 'a' }), { one: { name: 'n', extra: 1 } }));
      assert.deepEqual(m.ledger.toWireFormat(ledger, options(level)), { id: 'a', one: { name: 'n' } });
      assert.deepEqual((ledger as { one: unknown }).one, { name: 'n', extra: 1 }, 'the instance is not changed');
    });

    await t.test(`an instance of an open model strips the closed object that a pattern key holds, validate ${level}`, () => {
      // protects: T-896 a key that a pattern declares on an instance of an open model holds a closed object that strip walks
      const ledger = Object.assign(new m.PatternLedger({ id: 'a' }), { x_1: { name: 'n', extra: 1 }, other: 5 });
      assert.deepEqual(m.patternLedger.toWireFormat(ledger, options(level)), { id: 'a', x_1: { name: 'n' }, other: 5 });
    });

    await t.test(`an instance stays the same value when nothing in it changes, and a changed one keeps its class, validate ${level}`, () => {
      // protects: T-896 strip copies an instance only when a field changes, and the copy is read as the instance is
      const clean = new m.PetHolder({ pet: { kind: 'cat', lives: 9 } });
      assert.deepEqual(m.petHolder.toWireFormat(clean, options(level)), { pet: { kind: 'cat', lives: 9 } });
      const dirty = new m.PetHolder({ pet: { kind: 'cat', lives: 9, junk: 1 } });
      m.petHolder.toWireFormat(dirty, options(level));
      assert.deepEqual((dirty as { pet: unknown }).pet, { kind: 'cat', lives: 9, junk: 1 }, 'the instance is not changed');
    });
  }

  await t.test('a declared root field that a getter supplies is stripped with allowGetter, and a getter still does not count without it', () => {
    // protects: T-896 strip reads a field as the encoder reads it; a getter value counts only with allowGetter
    class Keeper { get pet() { return { kind: 'cat', lives: 9, junk: 1 }; } }
    assert.deepEqual(m.petHolder.toWireFormat(new Keeper(), { ...strip, allowGetter: true }), { pet: { kind: 'cat', lives: 9 } });
    assert.throws(() => m.petHolder.toWireFormat(new Keeper(), strip), isValidationError);
  });

  await t.test('a TSerde value keeps its model shape on encode and its wire shape on decode', () => {
    // protects: T-896 the plan holds the keys of the wire, so an encode must not apply it to the model value of a TSerde field
    assert.deepEqual(m.priced.toWireFormat({ price: { units: 5 }, note: 'n', extra: 1 }, strip), { price: { amount: '5' }, note: 'n' });
    assert.deepEqual(m.priced.fromWireFormat({ price: { amount: '5', junk: 1 }, extra: 1 }, strip), { price: { units: 5 } });
  });

  await t.test('a declared key with a bad value still fails, and without the option an extra key still fails', () => {
    // protects: T-896 strip on encode removes keys and does not hide a bad value; the default encode is unchanged
    assert.throws(
      () => m.plain.toWireFormat({ title: 5, extra: 1 }, strip),
      (error: unknown) => isValidationError(error) && error.issues.map((issue) => issue.path.join('.')).join() === 'title',
    );
    assert.throws(
      () => m.plain.toWireFormat(row),
      (error: unknown) => isValidationError(error) && error.issues.map((issue) => issue.path.join('.')).join() === 'extra',
    );
    assert.throws(() => m.plain.stringify(row), isValidationError);
  });

  await t.test('a tag of a number and a tag of the same text select their own variant, and a tag called __proto__ selects its variant', () => {
    // protects: T-896 the tag plans of an encode are told apart by the type of the tag
    assert.deepEqual(m.tagTypes.toWireFormat({ item: { kind: 1, a: 1, junk: 1 } }, strip), { item: { kind: 1, a: 1 } });
    assert.deepEqual(m.tagTypes.toWireFormat({ item: { kind: '1', b: 1, junk: 1 } }, strip), { item: { kind: '1', b: 1 } });
    assert.deepEqual(m.tagProto.toWireFormat({ item: { kind: '__proto__', a: 1, junk: 1 } }, strip), { item: { kind: '__proto__', a: 1 } });
  });

  const locks: [string, (value: object) => object][] = [['sealed', (value) => Object.seal(value)], ['frozen', (value) => Object.freeze(value)]];
  for (const [kind, lock] of locks) {
    await t.test(`a ${kind} instance whose field holds an object with extra keys encodes`, () => {
      // protects: T-896 the copy of an instance does not redefine a property that the instance made non-configurable
      const holder = lock(new m.PetHolder({ pet: { kind: 'cat', lives: 9, junk: 1 } }));
      assert.deepEqual(m.petHolder.toWireFormat(holder, strip), { pet: { kind: 'cat', lives: 9 } });
      assert.deepEqual(JSON.parse(m.petHolder.stringify(holder, strip)), { pet: { kind: 'cat', lives: 9 } });
      assert.deepEqual((holder as { pet: unknown }).pet, { kind: 'cat', lives: 9, junk: 1 }, 'the instance is not changed');
    });
  }

  await t.test('the input is not changed', () => {
    // protects: T-896 strip copies what it changes and never writes to the value
    const value = { inner: { title: 'a', x: 1 }, list: [{ title: 'b', y: 2 }], z: 3 };
    m.nested.toWireFormat(value, strip);
    assert.deepEqual(value, { inner: { title: 'a', x: 1 }, list: [{ title: 'b', y: 2 }], z: 3 });
  });
});

test('strip reaches a model of another module', async (t) => {
  // The project writes declarations and links the golem packages as an install does, so the plan that a module exports must have a type that a declaration file can name.
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-decode-strip-cross-', name: 'decode-strip-cross', compilerOptions: { declaration: true } });
  for (const file of ['child.model.ts', 'parent.model.ts']) fs.writeFileSync(path.join(sourceRoot, file), readFixture(`models/decode-strip/cross/${file}`));
  writeModelGolemYaml(root, { validation: true });
  const built = await buildModelProject(root);
  assert.equal(built.code, 0, `${built.stdout}${built.stderr}`);
  assert.ok(fs.existsSync(path.join(root, 'build/parent.model.generated.d.ts')), 'the build wrote declarations');
  const models = await import(pathToFileURL(path.join(root, 'build/parent.model.js')).href);
  const children = await import(pathToFileURL(path.join(root, 'build/child.model.js')).href);
  const parent = requireObjectCodec(generatedCodecIdFromRoot(root, 'TParent'));
  const wire = { id: 1, extra: 1, child: { name: 'a', x: 1 }, children: [{ name: 'b', y: 2 }] };

  for (const level of [true, 'sanity', false] as const) {
    await t.test(`a class result holds the declared keys of the nested model of another file, validate ${level}`, () => {
      // protects: T-896 the plan of the parent reaches the plan of a model of another module
      const result = parent.fromWireFormat(wire, { strip: true, validate: level, construct: models.Parent });
      assert.deepEqual(sorted(result as object), ['child', 'children', 'id']);
      assert.deepEqual(sorted(at(result, 'child')), ['name']);
      assert.deepEqual(sorted(at(result, 'children', 0)), ['name']);
      assert.ok(at(result, 'child') instanceof children.Child);
    });
  }

  await t.test('an encode drops the extra keys of the nested model of another file', () => {
    // protects: T-896 the plan of the parent reaches the plan of a model of another module, on encode too
    assert.deepEqual(parent.toWireFormat({ id: 1, extra: 1, child: { name: 'a', x: 1 }, children: [{ name: 'b', y: 2 }] }, { strip: true }), { id: 1, child: { name: 'a' }, children: [{ name: 'b' }] });
  });
});

test('strip reaches the SDK type that an app model holds', async (t) => {
  const closed = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, required, properties });
  const sdk: GolemModeSdkSetup = { document: chargesDocument({ Charge: closed({ id: { type: 'string' }, amount: { type: 'number' } }, ['id', 'amount']) }), folder: 'sdk/charges', name: 'Charges' };
  const order = `import type { IModel } from '@exprtlabs/golem/model';
import type { Charge } from '../sdk/charges/index.js';
export type TOrder = IModel<{ ref: string; charge: Charge; charges: Charge[] }>;
`;
  const project = await loadGolemModeProject(t, 'decode-strip-sdk-', [sdk], true, { 'src/order.model.ts': order });
  const generated = await import(pathToFileURL(path.join(project.root, 'build/src/order.model.generated.js')).href) as Record<string, (value: unknown, options?: object) => object>;
  const wire = { ref: 'r', extra: 1, charge: { id: 'c', amount: 1, x: 1 }, charges: [{ id: 'd', amount: 2, y: 2 }] };
  // protects: T-896 the plan of an app model reaches the plan of the SDK table node that it holds
  const decoded = generated.fromWireFormatTOrder!(wire, strip);
  assert.deepEqual(sorted(decoded), ['charge', 'charges', 'ref']);
  assert.deepEqual(sorted(at(decoded, 'charge')), ['amount', 'id']);
  assert.deepEqual(sorted(at(decoded, 'charges', 0)), ['amount', 'id']);
  assert.deepEqual(generated.toWireFormatTOrder!(wire, strip), { ref: 'r', charge: { id: 'c', amount: 1 }, charges: [{ id: 'd', amount: 2 }] });
});

test('strip reaches the model of another dependency group of a generated SDK', async (t) => {
  const closed = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, required, properties });
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const document = chargesDocument({
    // A date makes the schemas convert a value, so each of them gets a model group of its own.
    Leaf: closed({ label: { type: 'string' }, at: { type: 'string', format: 'date-time' } }, ['label', 'at']),
    Group: closed({ items: { type: 'array', items: ref('Leaf') } }, ['items']),
    Charge: closed({ group: ref('Group'), history: { type: 'array', items: ref('Group') } }, ['group', 'history']),
  });
  const sdk = await loadSdk(t, 'decode-strip-groups-', { document, name: 'Groups', dates: 'date', validation: true });
  const folder = path.join(sdk.output, 'dist/models');
  const groups = fs.readdirSync(folder).filter((file) => /^_group-.*\.js$/.test(file));
  assert.ok(groups.length > 1, 'each of the three schemas is a group of its own');
  const functions = new Map<string, (value: unknown, options?: object) => object>();
  for (const file of groups) {
    const exported = await import(pathToFileURL(path.join(folder, file)).href) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exported)) if (typeof value === 'function') functions.set(name, value as (value: unknown, options?: object) => object);
  }
  const named = (prefix: string) => functions.get([...functions.keys()].find((name) => name.startsWith(prefix) && /Charge/.test(name))!)!;
  const instant = '2024-01-02T03:04:05.000Z';
  const wire = { group: { items: [{ label: 'a', at: instant, x: 1 }], y: 1 }, history: [{ items: [], z: 1 }], w: 1 };
  // protects: T-896 the plan of one group reaches the plan that another group exports, on decode and encode
  const decoded = named('fromWireFormat')(wire, strip);
  assert.deepEqual(sorted(decoded), ['group', 'history']);
  assert.deepEqual(sorted(at(decoded, 'group')), ['items']);
  assert.deepEqual(sorted(at(decoded, 'group', 'items', 0)), ['at', 'label']);
  assert.deepEqual(sorted(at(decoded, 'history', 0)), ['items']);
  const value = { group: { items: [{ label: 'a', at: new Date(instant), x: 1 }], y: 1 }, history: [{ items: [], z: 1 }], w: 1 };
  assert.deepEqual(named('toWireFormat')(value, strip), { group: { items: [{ label: 'a', at: instant }] }, history: [{ items: [] }] });
});

test('a union of a recursive array of another group and an inline array keeps the items of the recursive array', async (t) => {
  const closed = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, required, properties });
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const document = chargesDocument({
    // `Tree` reaches itself through an inline object, so it is a named node of its own group and not written inline into the schemas that use it. The date of `Charge` makes it convert a value.
    Tree: { type: 'array', items: closed({ label: { type: 'string' }, children: ref('Tree') }, ['label']) },
    Charge: closed({
      when: { type: 'string', format: 'date-time' },
      holder: { oneOf: [ref('Tree'), { type: 'array', items: closed({ code: { type: 'string' } }, ['code']) }] },
    }, ['when', 'holder']),
  });
  const sdk = await loadSdk(t, 'decode-strip-tree-', { document, name: 'Trees', dates: 'date', validation: true });
  const folder = path.join(sdk.output, 'dist/models');
  const functions = new Map<string, (value: unknown, options?: object) => object>();
  for (const file of fs.readdirSync(folder).filter((entry) => /^_group-.*\.js$/.test(entry))) {
    const exported = await import(pathToFileURL(path.join(folder, file)).href) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exported)) if (typeof value === 'function') functions.set(name, value as (value: unknown, options?: object) => object);
  }
  const named = (prefix: string) => functions.get([...functions.keys()].find((name) => name.startsWith(prefix) && /Charge/.test(name))!)!;
  const instant = '2024-01-02T03:04:05.000Z';
  const wire = { when: instant, holder: [{ label: 'a', children: [{ label: 'b', children: [] }] }] };
  const value = { when: new Date(instant), holder: wire.holder };
  // protects: T-896 the plan of the recursive array is not the plan of the inline array: a value with no undeclared key is the same value with strip
  assert.deepEqual(named('fromWireFormat')(wire, strip), named('fromWireFormat')(wire));
  assert.deepEqual(named('toWireFormat')(value, strip), named('toWireFormat')(value));
});
