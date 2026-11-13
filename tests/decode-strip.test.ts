import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import type { DecodeOptions } from '@exprtlabs/golem/serde';

import { readFixture } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';

// `strip: true` on one decode call removes the keys that a closed object does not declare, at every level (R-65 G2).
// The default decode is unchanged: an extra key of a closed object fails validation.

type Model = new (values?: object) => object;
const strip = { strip: true } as const;
const isValidationError = (error: unknown): error is LibError => error instanceof LibError && error.kind === LibErrorKind.Validation;

async function buildModels(t: TestContext) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-decode-strip-', name: 'decode-strip', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'strip.model.ts'), readFixture('models/decode-strip/strip/strip.model.ts'));
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const models = await import(pathToFileURL(path.join(root, 'build/strip.model.js')).href);
  const codec = (name: string) => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  return {
    Card: models.Card as Model, Shelf: models.Shelf as Model, PetHolder: models.PetHolder as Model, Tree: models.Tree as Model, Tally: models.Tally as Model, Tagged: models.Tagged as Model,
    plain: codec('TPlain'), nested: codec('TNested'), open: codec('TOpen'), mapHolder: codec('TMapHolder'), patterned: codec('TPatterned'), nullable: codec('TNullable'), tagged: codec('TTagged'),
    card: codec('TCard'), shelf: codec('TShelf'), petHolder: codec('TPetHolder'), tree: codec('TTree'), tally: codec('TTally'),
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

test('strip reaches a model of another module', async (t) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-decode-strip-cross-', name: 'decode-strip-cross', linkWorkspaceNodeModules: true });
  for (const file of ['child.model.ts', 'parent.model.ts']) fs.writeFileSync(path.join(sourceRoot, file), readFixture(`models/decode-strip/cross/${file}`));
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
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
});
