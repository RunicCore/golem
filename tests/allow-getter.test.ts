import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';

import { createFixtureProject, readFixture } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, requireRecord } from './openapi/helpers.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';

// `allowGetter: true` on one encode or check call counts a declared root field that a getter or an inherited value
// supplies (R-14). The default reads own enumerable fields only, as JSON.stringify does.

type Model = new (values?: object) => object;
const allow = { allowGetter: true } as const;
const isValidationError = (error: unknown): error is LibError => error instanceof LibError && error.kind === LibErrorKind.Validation;

/** A value that is no model, with the declared field `title` on its prototype. */
class Named { get title(): string { return 'from getter'; } }

async function buildModels(t: TestContext) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-allow-getter-', name: 'allow-getter', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'getters.model.ts'), readFixture('models/allow-getter/getters/getters.model.ts'));
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const models = await import(pathToFileURL(path.join(root, 'build/getters.model.js')).href);
  const codec = (name: string) => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  return { Card: models.Card as Model, Tally: models.Tally as Model, plain: codec('TPlain'), outer: codec('TOuter'), card: codec('TCard'), tally: codec('TTally') };
}

test('allowGetter on a golem-model project', async (t) => {
  const { Card, Tally, plain, outer, card, tally } = await buildModels(t);

  await t.test('a declared root field from a getter counts only with allowGetter, for a plain value and a model instance', () => {
    // protects: R-14 allowGetter reads a declared root field from a getter; the default does not
    class Getter extends Card { get title(): string { return 'from getter'; } }
    for (const [codec, value] of [[plain, new Named()], [card, new Getter()]] as const) {
      assert.equal(codec.validate(value), false);
      assert.throws(() => codec.assert(value), isValidationError);
      assert.throws(() => codec.stringify(value), isValidationError);
      assert.throws(() => codec.toWireFormat(value), isValidationError);
      assert.equal(codec.validate(value, allow), true);
      assert.equal(codec.assert(value, allow), value, 'assert returns the value, not the copy');
      assert.equal(codec.stringify(value, allow), '{"title":"from getter"}');
      assert.deepEqual(codec.toWireFormat(value, allow), { title: 'from getter' });
    }
  });

  await t.test('allowGetter reads the root only: a nested getter, an extra key and a wrong optional type still fail', () => {
    // protects: R-14 the option applies to root fields only and changes no other judgment
    assert.equal(outer.validate({ inner: new Named() }, allow), false, 'a nested inherited getter');
    assert.equal(plain.validate({ title: 'a', extra: 1 }, allow), false, 'a plain value with an extra key');
    class Counted { title = 'a'; get count(): string { return 'x'; } }
    assert.equal(plain.validate(new Counted()), true, 'by default a getter supplies no field');
    assert.equal(plain.validate(new Counted(), allow), false, 'an optional field from a getter is judged with the option');
    assert.throws(() => plain.assert(new Counted(), allow), (error: unknown) => isValidationError(error) && error.issues.map(issue => issue.path).join() === 'count');
  });

  await t.test('a dynamic-map model instance keeps its extra keys as data with allowGetter', () => {
    // protects: R-14 the copy keeps the extra keys of a dynamic-map instance
    class Supplied extends Tally { get id(): string { return 'from getter'; } }
    const map = Object.assign(new Supplied(), { extra: 'x' });
    assert.equal(tally.stringify(map, allow), '{"id":"from getter","extra":"x"}');
    assert.deepEqual(tally.toWireFormat(map, allow), { id: 'from getter', extra: 'x' });
    assert.equal(tally.validate(Object.assign(new Supplied(), { extra: 1 }), allow), false, 'an extra key is judged by the map schema');
  });

  await t.test('a getter that throws gives the caller its own error, and a getter of program state never runs', () => {
    // protects: R-14 spec 4 a throwing getter leaves the call unchanged; program state is never read
    const boom = new RangeError('boom');
    class Throwing extends Card { get title(): string { throw boom; } }
    for (const call of [() => card.validate(new Throwing(), allow), () => card.stringify(new Throwing(), allow), () => card.toWireFormat(new Throwing(), allow)]) {
      assert.throws(call, (error: unknown) => error === boom);
    }
    let runs = 0;
    const state = Object.defineProperty(new Card({ title: 'a' }), 'cache', { enumerable: true, get() { runs += 1; throw boom; } });
    assert.equal(card.validate(state, allow), true);
    assert.equal(card.stringify(state, allow), '{"title":"a"}');
    assert.equal(runs, 0);
  });

  await t.test('encode reads each getter of a declared field once, also one that returns undefined', () => {
    // protects: R-14 spec 3.2 the copy shadows an undefined getter, so encode never runs it again
    let titles = 0;
    let counts = 0;
    class Reading extends Card {
      get title(): string { titles += 1; return 'a'; }
      get count(): number | undefined { counts += 1; return undefined; }
    }
    assert.equal(card.stringify(new Reading(), allow), '{"title":"a"}');
    assert.deepEqual([titles, counts], [1, 1]);
    assert.deepEqual(card.toWireFormat(new Reading(), allow), { title: 'a' });
    assert.deepEqual([titles, counts], [2, 2]);
  });

  await t.test('a polluted Object.prototype supplies a required field only with allowGetter', () => {
    // protects: F-193 the default stays exact against a polluted Object.prototype; allowGetter counts an inherited value (documented in R-14)
    Object.defineProperty(Object.prototype, 'title', { value: 'polluted', configurable: true, writable: true });
    try {
      assert.equal(plain.validate({}), false);
      assert.throws(() => plain.assert({}), isValidationError);
      assert.equal(plain.validate({}, allow), true);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'title');
    }
  });
});

test('a golem-openapi model instance encodes with each getter read once', async (t) => {
  // protects: R-14 spec 3.2 golem-openapi encode reads model[name] twice; the copy reads the getter once
  const output = path.join(createFixtureProject(t, 'golem-openapi-allow-getter-'), 'sdk');
  const item = { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, note: { type: 'string' } } };
  const content = { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } };
  const document = {
    openapi: '3.1.0',
    info: { title: 'Getters', version: '1' },
    paths: { '/items': { post: { operationId: 'createItem', requestBody: { required: true, content }, responses: { 201: { description: 'created', content } } } } },
    components: { schemas: { Item: item } },
  };
  await generateMaterializedSdk(document, { output, name: 'Getters', profile: { mobx: false, validation: true, allowAny: false } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir: path.join(output, 'dist') });
  const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
  const codec = requireObjectCodec(generatedCodecIdFromRoot(output, 'Item'));
  let names = 0;
  let notes = 0;
  class Reading extends (models.ItemModel as Model) {
    get name(): string { names += 1; return 'n'; }
    get note(): string | undefined { notes += 1; return undefined; }
  }
  assert.equal(codec.stringify(new Reading(), allow), '{"name":"n"}');
  assert.deepEqual([names, notes], [1, 1]);
  assert.deepEqual(codec.toWireFormat(new Reading(), allow), { name: 'n' });
  assert.deepEqual([names, notes], [2, 2]);
});
