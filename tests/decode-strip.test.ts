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
  const units = await import(pathToFileURL(path.join(root, 'build/units.js')).href) as { Price: new (units: number) => object };
  const codec = (name: string) => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  return {
    Price: units.Price,
    Card: models.Card as Model, Ledger: models.Ledger as Model, PatternLedger: models.PatternLedger as Model, Registry: models.Registry as Model, Shelf: models.Shelf as Model, PetHolder: models.PetHolder as Model, Tree: models.Tree as Model, Tally: models.Tally as Model, Tagged: models.Tagged as Model, TaggedOpen: models.TaggedOpen as Model,
    plain: codec('TPlain'), nested: codec('TNested'), open: codec('TOpen'), mapHolder: codec('TMapHolder'), patterned: codec('TPatterned'), nullable: codec('TNullable'), tagged: codec('TTagged'), patternItems: codec('TPatternItems'), tagTypes: codec('TTagTypes'), tagProto: codec('TTagProto'), suffixTuple: codec('TSuffixTuple'), leadingRest: codec('TLeadingRest'), headRest: codec('THeadRest'), taggedOpen: codec('TTaggedOpen'), priced: codec('TPriced'), classPriced: codec('TClassPriced'), metaTree: codec('TMetaTree'), petList: codec('TPetList'),
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

  await t.test('a tuple with items after its rest strips the rest and the items counted from the end', () => {
    // protects: T-896 a closed object in the middle or at the end of a tuple with a suffix loses its undeclared keys, and the open head keeps its own. A JSON Schema cannot validate such a tuple, so its model has no validation and `validate: false` is the only level.
    const wire = { rows: [{ title: 'h', x: 1 }, { title: 'a', count: 1, y: 2 }, { title: 'b', z: 3 }, { name: 'n', w: 4 }, { amount: 5, v: 6 }] };
    assert.deepEqual(m.suffixTuple.fromWireFormat(wire, options(false)), { rows: [{ title: 'h', x: 1 }, { title: 'a', count: 1 }, { title: 'b' }, { name: 'n' }, { amount: 5 }] });
    assert.deepEqual(m.suffixTuple.fromWireFormat({ rows: [{ title: 'h' }, { name: 'n', w: 4 }, { amount: 5, v: 6 }] }, options(false)), { rows: [{ title: 'h' }, { name: 'n' }, { amount: 5 }] }, 'no rest items');
    assert.deepEqual(m.leadingRest.fromWireFormat({ rows: [{ title: 'a', x: 1 }, { name: 'n', y: 2 }] }, options(false)), { rows: [{ title: 'a' }, { name: 'n' }] }, 'the rest is first');
    assert.deepEqual(wire.rows[1], { title: 'a', count: 1, y: 2 }, 'the input is not changed');
  });

  await t.test('an array too short for the head and the suffix gives its last items to the suffix, as the codec does', () => {
    // protects: T-896 the suffix never starts inside the head, and no item is stripped twice or by an index below zero
    const short = { rows: [{ title: 'h', x: 1 }, { name: 'n', w: 4 }] };
    assert.deepEqual(m.suffixTuple.fromWireFormat(short, options(false)), { rows: [{ title: 'h', x: 1 }, { name: 'n' }] });
    assert.deepEqual(m.suffixTuple.fromWireFormat({ rows: [{ amount: 5, v: 6 }] }, options(false)), { rows: [{ amount: 5, v: 6 }] }, 'one item is the head');
    assert.deepEqual(m.suffixTuple.fromWireFormat({ rows: [] }, options(false)), { rows: [] });
  });

  await t.test('an open head before a closed rest keeps its keys', () => {
    // protects: T-896 the plan of the rest is applied to the items after the head only
    for (const level of levels) {
      assert.deepEqual(m.headRest.fromWireFormat({ rows: [{ title: 'h', x: 1 }, { title: 'a', y: 2 }] }, options(level)), { rows: [{ title: 'h', x: 1 }, { title: 'a' }] }, `validate ${level}`);
    }
  });

  await t.test('a tagged union with an array variant strips the array items and the object variants', () => {
    // protects: T-896 the array variant of a tagged union, which takes its values by JSON type, has the plan of its items
    for (const level of levels) {
      assert.deepEqual(m.petList.fromWireFormat({ pet: [{ title: 'a', x: 1 }, { title: 'b' }] }, options(level)), { pet: [{ title: 'a' }, { title: 'b' }] }, `array, validate ${level}`);
      assert.deepEqual(m.petList.fromWireFormat({ pet: { kind: 'cat', lives: 9, junk: 1 } }, options(level)), { pet: { kind: 'cat', lives: 9 } }, `object, validate ${level}`);
    }
  });

  await t.test('a tag that is not an own enumerable property selects no variant, as in the decoder', () => {
    // protects: T-896 strip reads a tag by the JSON view of the decoder, so a value with a hidden tag goes to the default variant and keeps its declared keys
    for (const level of levels) {
      const hidden = Object.defineProperty({ amount: 1, junk: 1 }, 'kind', { value: 'other', enumerable: false });
      const decoded = m.tagged.fromWireFormat({ item: hidden }, options(level, { construct: m.Tagged }));
      assert.deepEqual(sorted(at(decoded, 'item')), ['amount'], `validate ${level}`);
    }
  });

  await t.test('data under a key that a closed object removes is not counted by the bound, and no getter of it runs', () => {
    // protects: T-896 a recursive model bounds the value that strip keeps, so deep junk under an undeclared key decodes from a value and from text
    const nested = (levels: number): unknown => (levels === 0 ? { end: 1 } : { next: nested(levels - 1) });
    const limited = { ...strip, maxDepth: 5 };
    for (const level of levels) {
      assert.deepEqual(m.tree.fromWireFormat({ name: 'a', junk: nested(10) }, { ...limited, validate: level }), { name: 'a' }, `fromWireFormat, validate ${level}`);
      assert.deepEqual(m.tree.parse(JSON.stringify({ name: 'a', junk: nested(10) }), { ...limited, validate: level }), { name: 'a' }, `parse, validate ${level}`);
      let reads = 0;
      const row = { name: 'a' };
      Object.defineProperty(row, 'secret', { enumerable: true, get() { reads += 1; throw new Error('secret read'); } });
      assert.deepEqual(m.tree.fromWireFormat(row, { ...strip, validate: level }), { name: 'a' }, `getter, validate ${level}`);
      assert.equal(reads, 0);
    }
  });

  await t.test('data that strip keeps and that is too deep is the depth error, also under a field that has no plan', () => {
    // protects: T-896 the bound after strip covers the whole kept value, so deep data that strip does not walk cannot reach the recursive decoder
    const depth = (limit: number) => (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Deserialization && error.causedByInput && error.message.includes(`deeper than ${limit} levels`);
    const deepTree = { name: 'a', kids: [{ name: 'b', kids: [{ name: 'c' }] }] };
    // `meta` keeps its other keys, so strip has no plan for it and does not walk what it holds.
    let deep: unknown = { x: 1 };
    for (let index = 0; index < 8; index++) deep = { x: [deep] };
    for (const level of levels) {
      const options = { ...strip, maxDepth: 2, validate: level };
      assert.throws(() => m.tree.fromWireFormat(deepTree, options), depth(2), `a planned level, fromWireFormat, validate ${level}`);
      assert.throws(() => m.tree.parse(JSON.stringify(deepTree), options), depth(2), `a planned level, parse, validate ${level}`);
      const holder = { name: 'h', meta: { title: 't', deep }, junk: 1 };
      assert.throws(() => m.metaTree.fromWireFormat(holder, { ...options, maxDepth: 5 }), depth(5), `an unplanned subtree, fromWireFormat, validate ${level}`);
      assert.throws(() => m.metaTree.parse(JSON.stringify(holder), { ...options, maxDepth: 5 }), depth(5), `an unplanned subtree, parse, validate ${level}`);
    }
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

  await t.test('a tagged union with an array variant drops the extra keys of the array items and of the object variants', () => {
    // protects: T-896 the array variant of a tagged union has the plan of its items on encode too
    for (const level of levels) {
      assert.deepEqual(m.petList.toWireFormat({ pet: [{ title: 'a', x: 1 }, { title: 'b' }] }, options(level)), { pet: [{ title: 'a' }, { title: 'b' }] }, `array, validate ${level}`);
      assert.deepEqual(m.petList.toWireFormat({ pet: { kind: 'cat', lives: 9, junk: 1 } }, options(level)), { pet: { kind: 'cat', lives: 9 } }, `object, validate ${level}`);
    }
  });

  await t.test('the model value of a TSerde field is not a level of strip, so a class value fits the bound of its parent', () => {
    // protects: T-896 strip leaves the model value of a serde field before it counts a level, as the depth check of the codec counts a class value as a leaf
    for (const level of levels) {
      assert.deepEqual(m.classPriced.toWireFormat({ price: new m.Price(5) }, { ...strip, validate: level, maxDepth: 1 }), { price: { amount: '5' } }, `validate ${level}`);
    }
  });

  await t.test('a tuple with items after its rest drops the extra keys of the rest and of the items counted from the end', () => {
    // protects: T-896 a closed object in the middle or at the end of a tuple with a suffix loses its undeclared keys on encode too; the model has no validation, so `validate: false` is the only level
    const value = { rows: [{ title: 'h', x: 1 }, { title: 'a', count: 1, y: 2 }, { title: 'b', z: 3 }, { name: 'n', w: 4 }, { amount: 5, v: 6 }] };
    const expected = { rows: [{ title: 'h', x: 1 }, { title: 'a', count: 1 }, { title: 'b' }, { name: 'n' }, { amount: 5 }] };
    assert.deepEqual(m.suffixTuple.toWireFormat(value, options(false)), expected);
    assert.deepEqual(JSON.parse(m.suffixTuple.stringify(value, options(false))), expected);
    assert.deepEqual(m.leadingRest.toWireFormat({ rows: [{ title: 'a', x: 1 }, { name: 'n', y: 2 }] }, options(false)), { rows: [{ title: 'a' }, { name: 'n' }] });
    assert.deepEqual(value.rows[1], { title: 'a', count: 1, y: 2 }, 'the input is not changed');
  });

  for (const level of levels) {
    await t.test(`an open head before a closed rest keeps its keys, validate ${level}`, () => {
      // protects: T-896 the plan of the rest is applied to the items after the head only
      assert.deepEqual(m.headRest.toWireFormat({ rows: [{ title: 'h', x: 1 }, { title: 'a', y: 2 }] }, options(level)), { rows: [{ title: 'h', x: 1 }, { title: 'a' }] });
    });
  }

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

test('strip walks the values as the encoder and the decoder walk them', async (t) => {
  const m = await buildModels(t);
  const levels = [true, false] as const;
  const cyclic = (error: unknown, kind: LibErrorKind) => error instanceof LibError && error.kind === kind && error.causedByInput === (kind === LibErrorKind.Deserialization) && /^Cyclic values cannot be/.test(error.message);
  const deeper = (limit: number, kind: LibErrorKind) => (error: unknown) => error instanceof LibError && error.kind === kind && error.message.includes(`deeper than ${limit} levels`);

  const holes = new Array<unknown>(3);
  holes[0] = { title: 'a', x: 1 };
  holes[2] = { title: 'b', y: 2 };
  const withHoles = { inner: { title: 'a' }, list: holes };
  const holeCalls: [string, () => unknown][] = [
    ['encode', () => m.nested.toWireFormat(withHoles, { validate: false })],
    ['encode with strip', () => m.nested.toWireFormat(withHoles, { ...strip, validate: false })],
    ['decode', () => m.nested.fromWireFormat(withHoles, { validate: false })],
    ['decode with strip', () => m.nested.fromWireFormat(withHoles, { ...strip, validate: false })],
  ];
  for (const [name, call] of holeCalls) {
    await t.test(`${name} keeps the holes of an array, validate false`, () => {
      // protects: T-896 a hole of an array stays a hole when an item before it is converted or stripped, as the conversion of an array leaves it
      const { list } = call() as { list: unknown[] };
      assert.equal(list.length, 3);
      assert.deepEqual(Object.keys(list), ['0', '2']);
    });
  }

  for (const level of levels) {
    await t.test(`a cyclic value with the bound off fails as it fails without strip, validate ${level}`, () => {
      // protects: T-896 strip never ends the call stack on a cycle: the caller gets the cycle error of the encoder and of the decoder
      const root: { name: string; kids: unknown[] } = { name: 'a', kids: [] };
      root.kids.push(root);
      const off = { validate: level, maxDepth: Infinity };
      assert.throws(() => m.tree.toWireFormat(root, off), (error) => cyclic(error, LibErrorKind.Serialization));
      assert.throws(() => m.tree.toWireFormat(root, { ...off, ...strip }), (error) => cyclic(error, LibErrorKind.Serialization));
      assert.throws(() => m.tree.fromWireFormat(root, off), (error) => cyclic(error, LibErrorKind.Deserialization));
      assert.throws(() => m.tree.fromWireFormat(root, { ...off, ...strip }), (error) => cyclic(error, LibErrorKind.Deserialization));
    });

    await t.test(`a retained chain of 50000 levels under the default bound is the depth error and never ends the call stack, validate ${level}`, () => {
      // protects: T-896 the check that tells a cycle from a value that is too deep keeps to the depth of the plain walk
      const chain: { name: string; kids?: unknown[] } = { name: 'a' };
      let tip = chain;
      for (let index = 0; index < 50_000; index++) {
        const next: { name: string; kids?: unknown[] } = { name: 'b' };
        tip.kids = [next];
        tip = next;
      }
      const depth = (kind: LibErrorKind) => (error: unknown) => error instanceof LibError && error.kind === kind && error.message.includes('deeper than 512 levels');
      assert.throws(() => m.tree.toWireFormat(chain, { ...strip, validate: level }), depth(LibErrorKind.Serialization));
      assert.throws(() => m.tree.fromWireFormat(chain, { ...strip, validate: level }), depth(LibErrorKind.Deserialization));
    });

    await t.test(`a cyclic value with a finite bound that the call stack cannot reach fails with the cycle error, validate ${level}`, () => {
      // protects: T-896 strip never ends the call stack on a cycle, whatever bound a caller sets
      const root: { name: string; kids: unknown[] } = { name: 'a', kids: [] };
      root.kids.push(root);
      const far = { validate: level, maxDepth: 100_000 };
      assert.throws(() => m.tree.toWireFormat(root, { ...far, ...strip }), (error) => cyclic(error, LibErrorKind.Serialization));
      assert.throws(() => m.tree.fromWireFormat(root, { ...far, ...strip }), (error) => cyclic(error, LibErrorKind.Deserialization));
    });

    await t.test(`a value that is too deep reports the depth, and no key that strip removes is read or searched for a cycle, validate ${level}`, () => {
      // protects: T-896 the check that tells a cycle from a value that is too deep follows the keys that strip walks only
      let reads = 0;
      const loop: { self?: unknown } = {};
      loop.self = loop;
      const row = { name: 'a', hidden: loop, kids: [{ name: 'b' }] };
      Object.defineProperty(row, 'secret', { enumerable: true, get() { reads += 1; throw new Error('secret read'); } });
      assert.throws(() => m.tree.toWireFormat(row, { ...strip, validate: level, maxDepth: 2 }), deeper(2, LibErrorKind.Serialization));
      assert.equal(reads, 0);
    });

    await t.test(`strip never reads the value of a key that a closed object removes, validate ${level}`, () => {
      // protects: T-896 a getter of an undeclared key does not run, so a throwing getter does not fail the call
      let reads = 0;
      const row = { title: 'a' };
      Object.defineProperty(row, 'secret', { enumerable: true, get() { reads += 1; throw new Error('secret read'); } });
      const options = { ...strip, validate: level };
      assert.deepEqual(m.plain.toWireFormat(row, options), { title: 'a' });
      assert.deepEqual(m.plain.fromWireFormat(row, options), { title: 'a' });
      assert.equal(reads, 0);
    });

    await t.test(`with the bound off, strip never reads the value of a key that a closed object removes, validate ${level}`, () => {
      // protects: T-896 the cycle check of the bound off walks the keys that strip walks, so a getter of an undeclared key does not run
      let reads = 0;
      const row = { title: 'a' };
      Object.defineProperty(row, 'secret', { enumerable: true, get() { reads += 1; throw new Error('secret read'); } });
      const options = { ...strip, validate: level, maxDepth: Infinity };
      assert.deepEqual(m.plain.toWireFormat(row, options), { title: 'a' });
      assert.deepEqual(m.plain.fromWireFormat(row, options), { title: 'a' });
      assert.equal(reads, 0);
    });

    await t.test(`with the bound off, a cycle under a key that a closed object removes is removed with no error, validate ${level}`, () => {
      // protects: T-896 a cycle that strip removes before it reads is not a cycle of the call
      const loop: { self?: unknown } = {};
      loop.self = loop;
      const row = { title: 'a', hidden: loop };
      const options = { ...strip, validate: level, maxDepth: Infinity };
      assert.deepEqual(m.plain.toWireFormat(row, options), { title: 'a' });
      assert.deepEqual(m.plain.fromWireFormat(row, options), { title: 'a' });
    });

    await t.test(`with the bound off, an object that two fields share is not a cycle, validate ${level}`, () => {
      // protects: T-896 the walk keeps the objects of its current path, not every object it has seen
      const shared = { name: 'shared', extra: 1 };
      const root = { name: 'a', kids: [shared, shared, { name: 'b', kids: [shared] }] };
      const expected = { name: 'a', kids: [{ name: 'shared' }, { name: 'shared' }, { name: 'b', kids: [{ name: 'shared' }] }] };
      const options = { ...strip, validate: level, maxDepth: Infinity };
      assert.deepEqual(m.tree.toWireFormat(root, options), expected);
      assert.deepEqual(m.tree.fromWireFormat(root, options), expected);
    });

    await t.test(`an encode with strip counts the levels of a value as a decode does, validate ${level}`, () => {
      // protects: T-896 strip agrees with the decoder on the level of the root
      const value = { name: 'a', kids: [{ name: 'b' }] };
      assert.throws(() => m.tree.toWireFormat(value, { ...strip, validate: level, maxDepth: 2 }), deeper(2, LibErrorKind.Serialization));
      assert.deepEqual(m.tree.toWireFormat(value, { ...strip, validate: level, maxDepth: 3 }), value);
    });
  }
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

test('a union of a concrete union of another group and an inline array keeps the items of both arrays', async (t) => {
  const closed = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, required, properties });
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const document = chargesDocument({
    // `Tree` is an array or a leaf and reaches itself through an inline object, so it is a named node of its own group. The date of `Charge` makes it convert a value.
    Tree: { oneOf: [{ type: 'array', items: closed({ label: { type: 'string' }, children: ref('Tree') }, ['label']) }, closed({ leaf: { type: 'string' } }, ['leaf'])] },
    Charge: closed({
      when: { type: 'string', format: 'date-time' },
      holder: { oneOf: [ref('Tree'), { type: 'array', items: closed({ code: { type: 'string' } }, ['code']) }] },
    }, ['when', 'holder']),
  });
  const sdk = await loadSdk(t, 'decode-strip-union-', { document, name: 'Unions', dates: 'date', validation: true });
  const folder = path.join(sdk.output, 'dist/models');
  const functions = new Map<string, (value: unknown, options?: object) => object>();
  for (const file of fs.readdirSync(folder).filter((entry) => /^_group-.*\.js$/.test(entry))) {
    const exported = await import(pathToFileURL(path.join(folder, file)).href) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exported)) if (typeof value === 'function') functions.set(name, value as (value: unknown, options?: object) => object);
  }
  const named = (prefix: string) => functions.get([...functions.keys()].find((name) => name.startsWith(prefix) && /Charge/.test(name))!)!;
  const instant = '2024-01-02T03:04:05.000Z';
  const tree = [{ label: 'a', children: { leaf: 'b' } }];
  const wire = { when: instant, holder: tree };
  const value = { when: new Date(instant), holder: tree };
  // protects: T-896 a union of another group is read by its own variants: two arrays make exact matching, and the plan of the inline array does not strip the items of the tree
  assert.deepEqual(named('fromWireFormat')(wire, strip), named('fromWireFormat')(wire));
  assert.deepEqual(named('toWireFormat')(value, strip), named('toWireFormat')(value));
  assert.deepEqual(named('fromWireFormat')({ when: instant, holder: { leaf: 'x', extra: 1 } }, strip), { when: new Date(instant), holder: { leaf: 'x' } }, 'the one object variant is stripped');
});
