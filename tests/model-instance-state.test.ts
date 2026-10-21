import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError } from '@exprtlabs/golem/errors';
import { encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { registerGeneratedModel } from '@exprtlabs/golem/model';
import { requireObjectCodec } from '@exprtlabs/golem/serde';

import { readFixture } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { compileValidatorModule } from './support/compiled-validators.js';
import { instanceFields, instanceFieldsSource } from '../packages/golem/src/presence.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
// An own key of a golem model instance that its own model does not declare is program state, never an unknown key
// (T-148). A key that the instance's own model declares is judged as before, and so is a value without a model.

class Task { title = 't'; done?: boolean; }
registerGeneratedModel(Task, { fields: ['title', 'done'] });
class Wide { title = 't'; note?: string; }
registerGeneratedModel(Wide, { fields: ['title', 'note'] });
// A derived model registers its full list: the nearest list decides, not the base's.
class Kid extends Task { mode?: string; }
registerGeneratedModel(Kid, { fields: ['title', 'done', 'mode'] });
// A dynamic-map model: every own key is data.
class Bag { title = 't'; }
registerGeneratedModel(Bag, { fields: ['title'], additionalProperties: true });
// A declared key that a pattern of patternProperties matches.
class Pat { title = 't'; xdeclared?: string; }
registerGeneratedModel(Pat, { fields: ['title', 'xdeclared'] });
class Circle { kind = 'a'; x = 1; }
registerGeneratedModel(Circle, { fields: ['kind', 'x'] });
class Reach { kind = 'a'; x = 1; y?: number; }
registerGeneratedModel(Reach, { fields: ['kind', 'x', 'y'] });

/** An instance of `Model` with `keys` set as own properties. */
function instance<Model extends object>(Model: new () => Model, keys: Record<string, unknown>): Model {
  return Object.assign(new Model(), keys);
}

const CLOSED = { type: 'object', required: ['title'], properties: { title: { type: 'string' }, done: { type: 'boolean' } }, additionalProperties: false };
const EVALUATED = { allOf: [{ type: 'object', properties: { title: { type: 'string' } } }], unevaluatedProperties: false };
const EVALUATED_VALUED = { allOf: [{ type: 'object', properties: { title: { type: 'string' } } }], unevaluatedProperties: { type: 'number' } };
const branch = (tag: string, key: string): object => ({ type: 'object', required: ['kind', key], properties: { kind: { const: tag }, [key]: { type: 'number' } }, additionalProperties: false });
const TAGGED = { oneOf: [branch('a', 'x'), branch('b', 'y')], discriminator: { propertyName: 'kind' } };
// An open model that lists its names, as golem-openapi writes `unevaluatedProperties: false` over an open base.
const NAMED = { type: 'object', properties: { title: { type: 'string' } }, propertyNames: { enum: ['title'] } };
const COUNTED_MAX = { type: 'object', properties: { title: { type: 'string' } }, maxProperties: 1 };
const COUNTED_MAX_NAMED = { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, maxProperties: 1 };
const COUNTED_MIN = { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, minProperties: 2 };
const PATTERNED = { type: 'object', properties: { title: { type: 'string' } }, patternProperties: { '^x': { type: 'number' } } };
const VALUED = { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: { type: 'number' } };
const compiled = compileValidatorModule({
  roots: { closed: CLOSED, evaluated: EVALUATED, evaluatedValued: EVALUATED_VALUED, tagged: TAGGED, named: NAMED, countedMax: COUNTED_MAX, countedMaxNamed: COUNTED_MAX_NAMED, countedMin: COUNTED_MIN, patterned: PATTERNED, valued: VALUED },
  fastPath: true,
});

// The places that report "this key is not allowed": the key test, unevaluatedProperties, propertyNames and the tagged-union pass.
const PLACES: readonly { readonly root: string; readonly fast: boolean; readonly rows: readonly (readonly [name: string, value: unknown, valid: boolean])[] }[] = [
  { root: 'closed', fast: true, rows: [
    ['a plain value with an extra key', { title: 'a', cache: 1 }, false],
    ['a model instance with own state', instance(Task, { cache: 1, hits: 3 }), true],
    ['a model instance with a declared key that the schema forbids', instance(Wide, { note: 'n' }), false],
    ['a derived instance whose own model declares the key', instance(Kid, { mode: 'm' }), false],
    ['a derived instance with own state', instance(Kid, { cache: 1 }), true],
    ['a value made from the model prototype, which holds an extra own key', Object.assign(Object.create(Task.prototype), { title: 'a', cache: 1 }), true],
    ['a dynamic-map instance, whose own keys are data', instance(Bag, { cache: 1 }), false],
  ] },
  { root: 'evaluated', fast: false, rows: [
    ['a plain value with an unevaluated key', { title: 'a', cache: 1 }, false],
    ['a model instance with own state', instance(Task, { cache: 1 }), true],
    ['a model instance with a declared key that nothing evaluated', instance(Wide, { note: 'n' }), false],
  ] },
  { root: 'evaluatedValued', fast: false, rows: [
    ['a plain value with a wrong unevaluated value', { title: 'a', cache: 'text' }, false],
    ['a model instance with own state of another type', instance(Task, { cache: 'text' }), true],
    ['a model instance with a declared key that only the unevaluated schema judges', instance(Wide, { note: 'n' }), false],
  ] },
  { root: 'named', fast: true, rows: [
    ['a plain value with a name outside the list', { title: 'a', cache: 1 }, false],
    ['a model instance with own state', instance(Task, { cache: 1 }), true],
    ['a model instance with a declared key outside the list', instance(Wide, { note: 'n' }), false],
  ] },
  { root: 'countedMax', fast: true, rows: [
    ['a plain value over the limit', { title: 'a', cache: 1 }, false],
    ['a model instance whose own state would pass the limit', instance(Task, { cache: 1 }), true],
  ] },
  { root: 'countedMaxNamed', fast: true, rows: [
    ['a plain value with both named keys', { title: 'a', note: 'n' }, false],
    ['a model instance whose named key is not declared by its model', instance(Task, { note: 'n' }), true],
  ] },
  { root: 'countedMin', fast: true, rows: [
    ['a plain value that reaches the minimum', { title: 'a', cache: 1 }, true],
    ['a model instance whose own state would reach the minimum', instance(Wide, { cache: 1 }), false],
    ['a model instance whose declared keys reach the minimum', instance(Wide, { note: 'n' }), true],
    ['a model instance whose named key is not declared by its model', instance(Task, { title: 'a', note: 'n' }), false],
  ] },
  { root: 'patterned', fast: true, rows: [
    ['a plain value with a wrong value at a pattern key', { title: 'a', xcache: 'text' }, false],
    ['a model instance with own state at a pattern key', instance(Task, { xcache: 'text' }), true],
    ['a model instance with a declared pattern key and a wrong value', instance(Pat, { xdeclared: 'text' }), false],
  ] },
  { root: 'valued', fast: true, rows: [
    ['a plain value with a wrong extra value', { title: 'a', cache: 'text' }, false],
    ['a model instance with own state of another type', instance(Task, { cache: 'text' }), true],
    ['a model instance with a declared key that only the extra schema judges', instance(Wide, { note: 'n' }), false],
    ['a dynamic-map instance with a wrong extra value', instance(Bag, { cache: 'text' }), false],
    ['a dynamic-map instance with a right extra value', instance(Bag, { cache: 1 }), true],
  ] },
  { root: 'tagged', fast: true, rows: [
    ['a plain value with a key that another branch declares', { kind: 'a', x: 1, y: 1 }, false],
    ['an instance with a key that no branch declares', instance(Circle, { cache: 1 }), true],
    ['an instance with a key that another branch declares', instance(Circle, { y: 1 }), true],
    ['an instance whose own model declares the key of another branch', instance(Reach, { y: 1 }), false],
    ['an instance with state and a wrong declared value', instance(Circle, { x: 'text', cache: 1 }), false],
  ] },
];

for (const { root, fast, rows } of PLACES) {
  for (const [name, value, valid] of rows) {
    test(`the ${root} check ${valid ? 'accepts' : 'rejects'} ${name}`, async () => {
      // protects: bug T-148 program state of a model instance is no unknown key, a declared key is still judged
      const module = await compiled;
      assert.equal(module.byRoot[root](value, false).length === 0, valid, 'the full validator');
      assert.equal(module.fastByRoot[root]?.(value), fast ? valid : undefined, 'the fast check');
    });
  }
}

for (const root of ['valued', 'patterned'] as const) {
  test(`the ${root} check looks up the field entry once for a plain value with many keys`, async () => {
    // protects: T-151 review the lazy field entry is cached also when it is null, so a plain value runs the lookup once
    const module = await compiled;
    let lookups = 0;
    const plain = new Proxy({ title: 'a', x1: 1, x2: 2, x3: 3, y1: 4, y2: 5 }, { getPrototypeOf: () => { lookups++; return Object.prototype; } });
    assert.equal(module.byRoot[root](plain, false).length, 0);
    assert.equal(lookups, 1, 'the full validator');
    lookups = 0;
    assert.equal(module.fastByRoot[root]?.(plain), true);
    assert.equal(lookups, 1,'the fast check');
  });
}

test('the runtime walk of the field entry and the walk the validators generate return the same names', () => {
  // protects: T-150 review the allowGetter copy and the generated validators decide program state by one rule
  const generated = new Function(`${instanceFieldsSource()}\nreturn instanceFields;`)() as (value: object) => readonly string[] | undefined;
  const values = [
    instance(Task, { cache: 1 }), instance(Kid, {}), instance(Bag, {}), Object.create(Task.prototype), new (class extends Task {})(),
    { title: 'a' }, Object.create(null), Object.create({ inherited: 1 }), [],
  ];
  assert.deepEqual(values.map(value => instanceFields(value)), values.map(value => generated(value)));
  assert.deepEqual(values.map(value => instanceFields(value)), [['title', 'done'], ['title', 'done', 'mode'], undefined, ['title', 'done'], ['title', 'done'], undefined, undefined, undefined, undefined]);
});

async function buildState(t: TestContext, mobx: boolean) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-instance-state-', name: 'model-instance-state', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'state.model.ts'), readFixture('models/model-instance-state/own-state/state.model.ts'));
  writeModelGolemYaml(root, { mobx, validation: true });
  await buildModelProject(root);
  const models = await import(`${pathToFileURL(path.join(root, 'build/state.model.js')).href}?mobx=${mobx}`);
  const codec = (name: string) => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  return { Task: models.Task as new (values?: object) => object, Board: models.Board as new (values?: object) => object, task: codec('TTask'), small: codec('TSmall'), board: codec('TBoard'), Bag: models.Bag as new (values?: object) => object, bag: codec('TBag'), Tally: models.Tally as new (values?: object) => object, tally: codec('TTally'), Empty: models.Empty as new (values?: object) => object, empty: codec('TEmpty'), Free: models.Free as new (values?: object) => object, free: codec('TFree'), Stamps: models.Stamps as new (values?: object) => object, stamps: codec('TStamps'), Note: models.Note as new (values?: object) => object, note: codec('TNote') };
}

for (const mobx of [false, true]) {
  test(`codec checks and encode keep the own state of a model class (mobx ${mobx})`, async (t) => {
    // protects: bug T-148 validate, assert, toWireFormat and stringify of a class with own state; a dynamic-map model keeps its keys
    const { Task: Model, Board, task, small, board, Bag, bag, Tally, tally } = await buildState(t, mobx);
    const value = new Model({ title: 'a', done: true });
    assert.equal(task.validate(value), true);
    assert.equal(task.assert(value), value);
    assert.deepEqual(task.toWireFormat(value), { title: 'a', done: true });
    assert.equal(task.stringify(value), '{"title":"a","done":true}');
    assert.equal(board.stringify(new Board({ lead: value })), '{"lead":{"title":"a","done":true}}', 'a nested instance with own state');
    assert.equal(small.validate(new Model({ title: 'a' })), true, 'own state beside the declared keys of an exact IObject');
    assert.equal(small.validate(value), false, 'the declared key done is not in the exact IObject');
    assert.throws(() => task.fromWireFormat({ title: 'a', cache: 1 }), (error: unknown) => {
      assert.ok(error instanceof LibError, 'a wire value with an extra key');
      assert.deepEqual(error.issues.map(issue => [issue.code, 'key' in issue ? issue.key : undefined]), [['unknownKey', 'cache']]);
      return true;
    });
    assert.equal(task.validate({ ...value }), false, 'a copy carries no model, so its own keys are data');
    const map = Object.assign(new Bag({ id: 'a' }), { extra: 1 });
    assert.equal(bag.validate(map), true);
    assert.equal(bag.stringify(map), '{"id":"a","extra":1}', 'a dynamic-map model writes its extra keys as data');
    assert.deepEqual(bag.toWireFormat(map), { id: 'a', extra: 1 });
    assert.equal(tally.validate(Object.assign(new Tally({ id: 'a' }), { n: 'x' })), true);
    assert.equal(tally.validate(Object.assign(new Tally({ id: 'a' }), { n: 1 })), false, 'an extra key of a dynamic map is data, judged by the map');
  });
}

test('an object with no declared field writes the same in stringify and toWireFormat', async (t) => {
  // protects: bug T-158 toWireFormat of a model with no declared field returned the instance with its program state; stringify wrote {}
  const { Empty, Free, empty, free } = await buildState(t, false);
  const instance = Object.assign(new Empty(), { cache: new Map<string, string>(), hits: 3 });
  assert.deepEqual(empty.toWireFormat(instance), {}, 'an instance of a model that is open by default');
  assert.equal(empty.stringify(instance), '{}');
  const map = Object.assign(new Free(), { extra: 'x' });
  assert.deepEqual(free.toWireFormat(map), { extra: 'x' }, 'a dynamic map keeps its keys as data');
  assert.equal(free.stringify(map), '{"extra":"x"}');
});

for (const validation of [true, false]) {
  test(`a model instance at any depth in an unknown field writes no program state (validation ${validation ? 'on' : 'off'})`, async (t) => {
    // protects: bug T-164 only the top value of an unknown field lost its program state; an instance inside an array or object kept it
    const { Task: TaskModel, Note, note } = await buildState(t, false);
    const task = () => Object.assign(new TaskModel({ title: 't' }), { cache: new Map<string, string>(), hits: 3 });
    const options = { validate: validation };
    const cases: readonly [string, unknown, unknown][] = [
      ['an array', [task()], [{ title: 't' }]],
      ['a nested plain object', { inner: { list: [1, task()] } }, { inner: { list: [1, { title: 't' }] } }],
      ['an instance', task(), { title: 't' }],
      ['a value with no model instance', { a: [1, { b: null }], c: 'x', d: [] }, { a: [1, { b: null }], c: 'x', d: [] }],
      ['a scalar', 'text', 'text'],
    ];
    for (const [label, data, expected] of cases) {
      const value = new Note({ title: 'n', data });
      assert.deepEqual(note.toWireFormat(value, options), { title: 'n', data: expected }, `toWireFormat of ${label}`);
      assert.equal(note.stringify(value, options), JSON.stringify({ title: 'n', data: expected }), `stringify of ${label}`);
    }
  });
}

test('the class-level encode of a model writes no program state of an instance inside its unknown field', async (t) => {
  // protects: bug T-164 a model nested as a field of another model is encoded by the class-level encode, which kept the state of an instance in its unknown field
  const { Task: TaskModel, Note } = await buildState(t, false);
  const task = Object.assign(new TaskModel({ title: 't' }), { cache: new Map<string, string>(), hits: 3 });
  assert.deepEqual(encodeGeneratedModel(new Note({ title: 'n', data: { list: [task] } })), { title: 'n', data: { list: [{ title: 't' }] } });
  assert.deepEqual(encodeGeneratedModel(new Note({ title: 'n', data: task })), { title: 'n', data: { title: 't' } });
});

test('parse with construct keeps the extra keys of a dynamic map, converts them, and stringify writes them back', async (t) => {
  // protects: bug T-163 parse with construct dropped the extra keys of a model with a dynamic map
  const { Bag, bag, Stamps, stamps } = await buildState(t, false);
  const parsed = bag.parse('{"id":"a","extra":1}', { construct: Bag }) as { id: string; extra: number };
  assert.ok(parsed instanceof Bag);
  assert.deepEqual({ ...parsed }, { id: 'a', extra: 1 });
  assert.equal(bag.stringify(parsed), '{"id":"a","extra":1}');
  assert.deepEqual(encodeGeneratedModel(parsed), { id: 'a', extra: 1 });
  assert.deepEqual({ ...(bag.parse('{"id":"a","extra":1}') as object) }, { id: 'a', extra: 1 }, 'without construct');

  const text = '{"first":"2020-01-01T00:00:00.000Z","later":"2021-02-03T04:05:06.000Z"}';
  const dated = stamps.parse(text, { construct: Stamps }) as { first: Date; later: Date };
  assert.ok(dated instanceof Stamps);
  assert.ok(dated.later instanceof Date, 'an extra value takes the conversion of the map value');
  assert.equal(dated.later.toISOString(), '2021-02-03T04:05:06.000Z');
  assert.equal(stamps.stringify(dated), text);
  assert.deepEqual(encodeGeneratedModel(dated), JSON.parse(text));
  assert.equal(stamps.stringify(new Stamps({ first: new Date(0), later: new Date(1000) })), '{"first":"1970-01-01T00:00:00.000Z","later":"1970-01-01T00:00:01.000Z"}', 'the constructor keeps and converts extra keys');
});

test('a default-open model without a dynamic map generates, and parse with construct and stringify write its declared fields only', async (t) => {
  // protects: bug T-163 the dynamic-map copy was emitted for exact: false models, whose generated types have no index signature
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-loose-', name: 'model-loose', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'loose.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TLooseBaseModel, type TLooseFields } from './loose.model.generated.js';
export type TLoose = IModel<{ id: string }>;
export class Loose extends TLooseBaseModel {
  constructor(values: Partial<TLooseFields> = {}) { super(values); }
}
`);
  writeModelGolemYaml(root, { mobx: false, validation: true, exact: false });
  await buildModelProject(root);
  const { Loose } = await import(pathToFileURL(path.join(root, 'build/loose.model.js')).href) as { Loose: new (values?: object) => object };
  const codec = requireObjectCodec(generatedCodecIdFromRoot(root, 'TLoose'));
  const parsed = codec.parse('{"id":"a","extra":1}', { construct: Loose });
  assert.ok(parsed instanceof Loose);
  assert.deepEqual({ ...parsed }, { id: 'a' });
  assert.equal(codec.stringify(new Loose({ id: 'a', extra: 1 } as object)), '{"id":"a"}');
});

async function buildLoose(t: TestContext) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-loose-state-', name: 'model-loose-state', linkWorkspaceNodeModules: true });
  fs.writeFileSync(path.join(sourceRoot, 'loose.model.ts'), readFixture('models/model-instance-state/loose-state/loose.model.ts'));
  writeModelGolemYaml(root, { mobx: false, validation: true, exact: false });
  await buildModelProject(root);
  const models = await import(pathToFileURL(path.join(root, 'build/loose.model.js')).href);
  const codec = (name: string) => requireObjectCodec(generatedCodecIdFromRoot(root, name));
  type Make = new (values?: object) => object;
  return { Loose: models.Loose as Make, LooseNote: models.LooseNote as Make, loose: codec('TLoose'), note: codec('TLooseNote') };
}

test('a loose model instance inside an unknown field writes no program state', async (t) => {
  // protects: bug T-191 a loose (exact: false) model registered an open map, so the program state of its instance was written inside an unknown value
  const { Loose, LooseNote, note } = await buildLoose(t);
  const inner = Object.assign(new Loose({ id: 'a' }), { cache: new Map<string, string>(), hits: 3 });
  const value = new LooseNote({ title: 'n', data: { list: [inner], direct: inner } });
  const written = { title: 'n', data: { list: [{ id: 'a' }], direct: { id: 'a' } } };
  assert.deepEqual(note.toWireFormat(value), written);
  assert.equal(note.stringify(value), JSON.stringify(written));
  assert.deepEqual(note.toWireFormat(value, { validate: false }), written, 'validation off');
  assert.equal(note.stringify(value, { validate: false }), JSON.stringify(written), 'validation off');
  assert.deepEqual(encodeGeneratedModel(value), written, 'the class-level encode');
});
