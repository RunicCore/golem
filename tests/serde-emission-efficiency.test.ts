import { copyFixtureFile, readFixture } from './fixture-project.js';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { GeneratedModel, GeneratedModelConstructor } from '@exprtlabs/golem/model';
import { generateModels } from '#openapi/models';
import { writeSdk } from '#openapi/generator';
import { buildModelProject, createModelProject, generatedModelFiles, writeModelGolemYaml } from './model-project.js';
import { writeGeneratedSdk } from './openapi/helpers.js';
import { spyOnBuild } from './support/build-spy.js';
import { command } from './support/process.js';

const fixture = (t: TestContext) => createModelProject(t, {
  prefix: 'golem-serde-emission-',
  name: 'serde-emission-efficiency',
});

function modelArtifact(artifacts: readonly { readonly path: string; readonly content: string }[], name: string): string {
  return artifacts.find((artifact) => artifact.path.endsWith(`/${name}.model.generated.ts`))?.content ?? '';
}

test('model generation preserves imported model identity and detached JSON output', async (t) => {
  const value = fixture(t);
  const sdk = path.join(value.sourceRoot, 'sdk');
  mkdirSync(sdk, { recursive: true });
  const document = {
    openapi: '3.1.0',
    info: { title: 'External model', version: '1' },
    components: {
      schemas: {
        Money: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'number' },
            currency: { type: 'string' },
          },
        },
      },
    },
  };
  writeGeneratedSdk(writeSdk, document, {
    output: sdk,
    profile: { mobx: false, validation: false, allowAny: false },
  });
  writeFileSync(path.join(value.sourceRoot, 'wallet.model.ts'), readFixture("models/serde-emission-efficiency/model-generation-preserves-imported-model-identity-and-detached-json-output/wallet.model.ts"));

  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await buildModelProject(value.root);
  // Text check kept: calling a shared stringify function or inlining its body gives the same output and the same calls.
  assert.match(modelArtifact(generatedModelFiles(value.root), 'wallet'), /stringifyMoney\(/, 'one stringify function per interned node: wallet calls stringifyMoney instead of inlining it');

  const spy = await spyOnBuild(value.root, {
    '@exprtlabs/golem/conversion': ['decodeGeneratedModel', 'decodeGeneratedModelTrusted', 'encodeGeneratedModel'],
    '@exprtlabs/golem/serde': ['requireObjectCodec'],
  });
  try {
    const sdkModule = await import(pathToFileURL(path.join(value.root, 'build/sdk/index.js')).href) as {
      readonly MoneyModel: new (values?: { amount?: number; currency?: string }) => object;
    };
    const walletModule = await import(pathToFileURL(path.join(value.root, 'build/wallet.model.js')).href) as {
      readonly Wallet: new (values?: { money?: object }) => object;
    };
    const { stringifyTWallet } = await import(pathToFileURL(path.join(value.root, 'build/wallet.model.generated.js')).href) as {
      readonly stringifyTWallet: (value: object) => string;
    };
    const wallet = await decodeGeneratedModel(walletModule.Wallet, {
      money: { amount: 7, currency: 'USD' },
    }) as { readonly money: object };
    assert.ok(wallet.money instanceof sdkModule.MoneyModel, 'external model is reconstructed as a concrete instance');
    assert.deepEqual(spy.calls.map((call) => [call.name, call.args[0]]), [['decodeGeneratedModelTrusted', sdkModule.MoneyModel]], 'budget: decoding an already-known external model uses the trusted fast path, once');
    spy.calls.length = 0;
    const wire = await encodeGeneratedModel(wallet as never) as { readonly money: object };
    assert.deepEqual(spy.calls.map((call) => call.name), ['encodeGeneratedModel'], 'budget: encoding an external model reuses the shared encodeGeneratedModel helper');
    spy.calls.length = 0;
    const text = JSON.stringify(wire);
    assert.notStrictEqual(wire.money, wallet.money, 'wire output is detached from the external model');
    assert.equal(text, '{"money":{"amount":7,"currency":"USD"}}');
    assert.equal(stringifyTWallet(wallet), text);
    assert.deepEqual(spy.calls, [], 'budget: a known Money codec is stringified by direct call, not a runtime requireObjectCodec lookup or an encode');
  } finally { spy.stop(); }
});

test('model decoder leaves unchanged fields in the initializer copy', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'item.model.ts'), readFixture("models/serde-emission-efficiency/model-decoder-leaves-unchanged-fields-in-the-initializer-copy/item.model.ts"));
  copyFixtureFile(
    value.root,
    'models/serde-emission-efficiency/model-decoder-leaves-unchanged-fields-in-the-initializer-copy/codecs.ts',
    'src/codecs.ts',
  );
  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await buildModelProject(value.root);
  const spy = await spyOnBuild(value.root, { '@exprtlabs/golem/conversion': ['defineModelProperty'] });
  try {
    const { Item } = await import(pathToFileURL(path.join(value.root, 'build/item.model.js')).href);
    const wire = { title: 'T', code: 'ABC' };
    const item = decodeGeneratedModel(Item, wire);
    // The decoder defines its fields on a plain copy of the wire values; the constructor defines them on the model.
    const redefinedInCopy = spy.calls
      .filter((call) => Object.getPrototypeOf(call.args[0]) === Object.prototype)
      .map((call) => call.args[1]);
    assert.deepEqual(redefinedInCopy, ['code'], 'budget: only the field with a codec is redefined in the copy, the unchanged title is left in it');
    assert.equal(item.title, 'T');
    assert.equal(item.code, 'abc');
    assert.deepEqual(wire, { title: 'T', code: 'ABC' }, 'the decoder converts a copy, not the caller\'s wire');
  } finally { spy.stop(); }
});

test('generated decoding preserves the constructor and initializer boundaries', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'child.model.ts'), readFixture("models/serde-emission-efficiency/generated-decoding-preserves-the-constructor-and-initializer-boundaries/child.model.ts"));
  writeFileSync(path.join(value.sourceRoot, 'optional-codec.ts'), readFixture("models/serde-emission-efficiency/generated-decoding-preserves-the-constructor-and-initializer-boundaries/optional-codec.ts"));
  writeFileSync(path.join(value.sourceRoot, 'parent.model.ts'), readFixture("models/serde-emission-efficiency/generated-decoding-preserves-the-constructor-and-initializer-boundaries/parent.model.ts"));

  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await buildModelProject(value.root);
  // Parent's generated companion imports Child through the ordinary module
  // URL. Keep the test imports on that same URL so constructor identity and
  // static counters are shared with the generated decoder.
  const childModule = await import(pathToFileURL(path.join(value.root, 'build/child.model.js')).href);
  const parentModule = await import(pathToFileURL(path.join(value.root, 'build/parent.model.js')).href);
  const Child = childModule.Child as new (...arguments_: never[]) => object;
  const Parent = parentModule.Parent as new (...arguments_: never[]) => object;
  const childState = childModule.Child as { constructed: number };
  const parentState = parentModule.Parent as {
    constructed: number;
    setterCalls: number;
    sawChildInstance: boolean;
    sawExtra: boolean;
    sawExtraValue: unknown;
    initializerPrototype: object | null;
    prototype: object;
  };
  const input = Object.fromEntries([
    ['child', {}],
    ['label', 'wire-label'],
    ['__serdeAccessorProbe', 'probe'],
    ['extra', 'visible-to-constructor'],
  ]);
  const probeName = '__serdeAccessorProbe';
  let objectPrototypeSetterCalls = 0;
  const previousProbe = Object.getOwnPropertyDescriptor(Object.prototype, probeName);
  Object.defineProperty(Object.prototype, probeName, {
    configurable: true,
    set(_value: unknown) { objectPrototypeSetterCalls += 1; },
  });
  try {
    const parent = decodeGeneratedModel(Parent, input) as {
      child: { readonly name: string };
      readonly label: string;
      readonly __serdeAccessorProbe: string;
    };
    assert.equal(childState.constructed, 1, 'nested concrete constructor runs once');
    assert.equal(parentState.constructed, 1, 'requested concrete constructor runs once');
    assert.equal(parentState.sawChildInstance, true, 'nested conversion completes before parent construction');
    assert.equal(parentState.sawExtra, true, 'extra own keys remain visible to handwritten constructors');
    assert.equal(parentState.sawExtraValue, 'visible-to-constructor');
    assert.strictEqual(parentState.initializerPrototype, Object.prototype, 'initializer keeps an ordinary prototype');
    assert.equal(parentState.setterCalls, 0, 'generated field definition does not invoke an inherited setter');
    assert.equal(parent['__serdeAccessorProbe'], 'probe');
    assert.equal(Object.hasOwn(parent, probeName), true, 'generated model retains the probe as own data');
    assert.equal(Object.propertyIsEnumerable.call(parent, probeName), true, 'generated model retains enumerable field data');
    assert.equal(parent.child.name, 'default', 'constructor defaults survive nested conversion');
    assert.deepEqual(Object.getOwnPropertyDescriptor(parent, 'child'), {
      value: parent.child, enumerable: true, configurable: true, writable: true,
    }, 'ordinary generated fields retain standard own data descriptors');
    assert.equal(Object.hasOwn(parent, 'note'), false, 'absent optional fields stay absent');
    assert.equal(Object.hasOwn(parent, 'label'), true, 'ordinary data fields survive');
    assert.equal(parent.label, 'wire-label');
    assert.strictEqual(Object.getPrototypeOf(parent), parentState.prototype);

    const wire = encodeGeneratedModel(parent as typeof parent & GeneratedModel<unknown>) as Record<string, unknown>;
    assert.equal(wire[probeName], 'probe');
    assert.equal(Object.hasOwn(wire, probeName), true, 'serialized output retains the probe as own data');
    assert.equal(Object.propertyIsEnumerable.call(wire, probeName), true, 'serialized output retains enumerable field data');
    assert.strictEqual(Object.getPrototypeOf(wire), Object.prototype, 'serialized output keeps an ordinary prototype');
    Object.defineProperty(parent, 'note', { value: undefined, enumerable: true, configurable: true });
    const presentUndefined = encodeGeneratedModel(parent) as Record<string, unknown>;
    assert.equal(Object.hasOwn(presentUndefined, 'note'), false, 'an undefined optional field is omitted like JSON.stringify does');
    Reflect.deleteProperty(parent, 'note');
    const absent = encodeGeneratedModel(parent) as Record<string, unknown>;
    assert.equal(Object.hasOwn(absent, 'note'), false);
    const codec = await import(pathToFileURL(path.join(value.root, 'build/optional-codec.js')).href);
    assert.equal(codec.encodeCalls, 0, 'absent optional codecs are never invoked');
    Object.defineProperty(parent, 'code', { value: 'x', enumerable: true, configurable: true });
    const encodedCode = encodeGeneratedModel(parent) as Record<string, unknown>;
    assert.equal(encodedCode.code, 'X');
    assert.equal(codec.encodeCalls, 1, 'present optional codec executes exactly once');
    assert.equal(objectPrototypeSetterCalls, 0, 'generated conversion never assigns through Object.prototype');

    const encodedWire = encodeGeneratedModel(parent as typeof parent & GeneratedModel<unknown>) as Record<string, unknown>;
    JSON.stringify(encodedWire);
    assert.equal(codec.encodeCalls, 2, 'JSON writing does not replay the field codec');
  } finally {
    if (previousProbe) Object.defineProperty(Object.prototype, probeName, previousProbe);
    else Reflect.deleteProperty(Object.prototype, probeName);
  }
});

test('OpenAPI generated models use the same detached JSON serialization as object serialization', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'types.ts'), readFixture("models/serde-emission-efficiency/openapi-generated-models-use-the-same-detached-json-serialization-as-object-/types.ts"));
  const source = generateModels({
    openapi: '3.1.0',
    info: { title: 'Emission', version: '1' },
    components: {
      schemas: {
        Child: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string' } },
        },
        Parent: {
          type: 'object',
          required: ['title', 'child'],
          properties: {
            title: { type: 'string' },
            child: { $ref: '#/components/schemas/Child' },
            labels: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }, { mobx: false, validation: false });
  writeFileSync(path.join(value.sourceRoot, 'models.ts'), source);
  await buildModelProject(value.root);

  const models = await import(pathToFileURL(path.join(value.root, 'build/models.js')).href) as unknown as {
    readonly ChildModel: new (values?: Record<string, unknown>) => object;
    readonly ParentModel: new (values?: Record<string, unknown>) => object;
  };
  const child = new models.ChildModel({ value: 'child' });
  const parent = new models.ParentModel({ title: 'parent', child, labels: ['one', 'two'] });
  const wire = encodeGeneratedModel(parent as GeneratedModel<unknown>);
  const text = JSON.stringify(wire);
  assert.equal(text, '{"title":"parent","child":{"value":"child"},"labels":["one","two"]}');

  // The decoder hands a model with a converted field a shallow copy of the wire, and a model with none the wire itself.
  const initializers: unknown[] = [];
  class SeenChild extends models.ChildModel { constructor(values?: Record<string, unknown>) { initializers.push(values); super(values); } }
  class SeenParent extends models.ParentModel { constructor(values?: Record<string, unknown>) { initializers.push(values); super(values); } }
  const childWire = { value: 'child' };
  decodeGeneratedModel(SeenChild as unknown as GeneratedModelConstructor, childWire);
  assert.strictEqual(initializers.pop(), childWire, 'budget: a model with no converted fields takes the wire object as its initializer, with no copy');
  const parentWire = { title: 'parent', child: { value: 'child' }, extra: 1 };
  decodeGeneratedModel(SeenParent as unknown as GeneratedModelConstructor, parentWire);
  const initializer = initializers.pop() as Record<string, unknown>;
  assert.notStrictEqual(initializer, parentWire);
  assert.equal(initializer.title, 'parent', 'budget: the initializer starts as a shallow copy of the wire, so an unchanged field stays in it');
  assert.equal(initializer.extra, 1);
  assert.ok(initializer.child instanceof models.ChildModel, 'the nested $ref field is converted');
  assert.deepEqual(parentWire, { title: 'parent', child: { value: 'child' }, extra: 1 }, 'the caller\'s wire is not changed');
});

test('nested local models decode through the local converter of the nested model', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'team.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TMemberBaseModel, TStampBaseModel, TTeamBaseModel } from './team.model.generated.js';
export type TStamp = IModel<{ time: number }>;
export class Stamp extends TStampBaseModel {}
export type TMember = IModel<{ name: string; joined: Stamp }>;
export class Member extends TMemberBaseModel {}
export type TTeam = IModel<{ lead: Member; members: Member[] }>;
export class Team extends TTeamBaseModel {}
`);
  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await buildModelProject(value.root);
  const spy = await spyOnBuild(value.root, { '@exprtlabs/golem/conversion': ['decodeCheckedInput', 'decodeDetachedInput'] });
  try {
    const { Team } = await import(pathToFileURL(path.join(value.root, 'build/team.model.js')).href);
    // Nested values are the generated classes; a model file's own subclasses aren't visible to its companion.
    const { TMemberBaseModel: Member, TStampBaseModel: Stamp } = await import(pathToFileURL(path.join(value.root, 'build/team.model.generated.js')).href);
    const { requireObjectCodec } = await import('@exprtlabs/golem/serde');
    const input = { lead: { name: 'Ada', joined: { time: 1 } }, members: [{ name: 'Lin', joined: { time: 2 } }] };
    const codec = requireObjectCodec<InstanceType<typeof Team>>('TTeam');
    const entries = [
      { check: 'decodeCheckedInput', decode: () => codec.fromWireFormat(input, { construct: Team }) },
      { check: 'decodeDetachedInput', decode: () => codec.parse(JSON.stringify(input), { construct: Team }) },
    ];
    for (const { check, decode } of entries) {
      spy.calls.length = 0;
      const team = decode() as Record<string, any>;
      // Nested models call the module's own converter, not the public entry that checks its input again.
      assert.deepEqual(spy.calls.map((call) => call.name), [check], 'one input check for the root, none for the nested models');
      assert.ok(team instanceof Team);
      assert.ok(team.lead instanceof Member && team.lead.joined instanceof Stamp);
      assert.ok(team.members[0] instanceof Member && team.members[0].joined instanceof Stamp);
      assert.deepEqual(encodeGeneratedModel(team as never), input);
    }
    // fromWireFormat still detaches the result from the caller's objects at every depth.
    const detached = codec.fromWireFormat(input, { construct: Team }) as Record<string, any>;
    input.lead.joined.time = 99;
    input.members[0].name = 'Changed';
    assert.equal(detached.lead.joined.time, 1);
    assert.equal(detached.members[0].name, 'Lin');
  } finally { spy.stop(); }
});

test('model encoding assigns present fields in declaration order without deleting keys', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'note.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TNoteBaseModel } from './note.model.generated.js';
export type TNote = IModel<{ title: string; body?: string; pinned: boolean }>;
export class Note extends TNoteBaseModel {}
`);
  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await buildModelProject(value.root);
  const { Note } = await import(pathToFileURL(path.join(value.root, 'build/note.model.js')).href);
  const keys = (init: object) => Object.keys(encodeGeneratedModel(new Note(init) as never));
  assert.deepEqual(keys({ title: 't', pinned: true }), ['title', 'pinned']);
  assert.deepEqual(keys({ title: 't', body: undefined, pinned: true }), ['title', 'pinned'], 'an undefined optional field is omitted');
  assert.deepEqual(keys({ pinned: false, body: 'b', title: 't' }), ['title', 'body', 'pinned'], 'declaration order, not initializer order');
  assert.deepEqual(encodeGeneratedModel(new Note({ title: 't', body: 'b', pinned: false }) as never), { title: 't', body: 'b', pinned: false });
  assert.equal(Object.hasOwn(encodeGeneratedModel(new Note({ title: 't', pinned: true }) as never) as object, 'body'), false, 'an absent field is not an own key');

  // Only V8 property shape shows whether an absent field was added and then deleted, which turns the result into a
  // dictionary-mode object. No portable check proves it, so the probe runs where V8 accepts its flag.
  const natives = process.versions.v8 === undefined
    ? undefined
    : await command(value.root, process.execPath, ['--allow-natives-syntax', '-e', 'console.log(%HasFastProperties({}))'], { allowFailure: true });
  if (natives?.stdout.trim() !== 'true') {
    t.diagnostic('skipped the property-shape probe: this runtime has no V8 --allow-natives-syntax');
    return;
  }
  const probe = path.join(value.root, 'fast-properties.mjs');
  writeFileSync(probe, [
    "import { encodeGeneratedModel } from '@exprtlabs/golem/conversion';",
    "import { Note } from './build/note.model.js';",
    "console.log(%HasFastProperties(encodeGeneratedModel(new Note({ title: 't', pinned: true }))));",
  ].join('\n'));
  assert.equal((await command(value.root, process.execPath, ['--allow-natives-syntax', probe])).stdout.trim(), 'true', 'budget: the encoded object keeps fast properties when a middle field is absent');
});

test('a map whose values need no conversion is written by the native JSON writer, and a map of dates still converts', async (t) => {
  // protects: T-202 a zero-field map of plain values stringifies with JSON.stringify, not the per-key extras loop
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'maps.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TDirectoryBaseModel, TShelfBaseModel, TStampsBaseModel } from './maps.model.generated.js';
export type TDirectory = IModel<{ [key: string]: string }>;
export type TShelf = IModel<{ id: string; names: { [key: string]: string } }>;
export type TStamps = IModel<{ [key: string]: Date }>;
export class Directory extends TDirectoryBaseModel {}
export class Shelf extends TShelfBaseModel {}
export class Stamps extends TStampsBaseModel {}
`);
  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await buildModelProject(value.root);
  const spy = await spyOnBuild(value.root, {
    '@exprtlabs/golem/serde': ['stringifyJsonScalar', 'stringifyJsonString', 'stringifyJsonNumber', 'stringifyJsonBoolean', 'stringifyJsonArray'],
  });
  try {
    const codecs = await import(pathToFileURL(path.join(value.root, 'build/maps.model.generated.js')).href) as Record<string, (value: unknown) => unknown>;
    const { Directory } = await import(pathToFileURL(path.join(value.root, 'build/maps.model.js')).href) as { Directory: new () => object };
    const names = { zeta: 'z', alpha: 'a', 2: 'two', 1: 'one', skipped: undefined, empty: '' };
    const instance = Object.assign(new Directory(), names);
    spy.calls.length = 0;
    assert.equal(codecs.stringifyTDirectory(instance), JSON.stringify(names), 'extra keys and their order are kept');
    assert.deepEqual(spy.calls.map((call) => [call.name, call.args[0]]), [['stringifyJsonScalar', instance]], 'the plain map takes the native writer, with no per-key loop');
    assert.equal(codecs.stringifyTDirectory(instance), '{"1":"one","2":"two","zeta":"z","alpha":"a","empty":""}');
    assert.deepEqual(codecs.toWireFormatTDirectory(instance), JSON.parse(codecs.stringifyTDirectory(instance) as string), 'toWireFormat agrees with stringify');
    spy.calls.length = 0;
    assert.equal(codecs.stringifyTShelf({ id: 's', names }), JSON.stringify({ id: 's', names }));
    assert.deepEqual(spy.calls.map((call) => [call.name, call.args[0]]).sort(), [['stringifyJsonScalar', names], ['stringifyJsonString', 's']], 'a plain map field takes the native writer too');

    const stamps = { first: new Date('2024-01-01T00:00:00.000Z'), second: new Date('2024-02-02T00:00:00.000Z') };
    assert.equal(codecs.stringifyTStamps(stamps), '{"first":"2024-01-01T00:00:00.000Z","second":"2024-02-02T00:00:00.000Z"}');
    assert.deepEqual(codecs.toWireFormatTStamps(stamps), { first: '2024-01-01T00:00:00.000Z', second: '2024-02-02T00:00:00.000Z' });
  } finally { spy.stop(); }
});

test('a map of numbers throws on a non-finite value with validation off, as a number field does', async (t) => {
  // protects: T-212 a non-finite number in a plain map is a Serialization LibError, not null (found in T-202)
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'counts.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TCountsBaseModel, TSeriesBaseModel } from './counts.model.generated.js';
export type TCounts = IModel<{ [key: string]: number }>;
export type TSeries = IModel<{ [key: string]: number[] }>;
export class Counts extends TCountsBaseModel {}
export class Series extends TSeriesBaseModel {}
`);
  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await buildModelProject(value.root);
  const codecs = await import(pathToFileURL(path.join(value.root, 'build/counts.model.generated.js')).href) as Record<string, (value: unknown) => unknown>;
  const isSerializationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Serialization;
  assert.equal(codecs.stringifyTCounts({ a: 1, b: -0.5 }), '{"a":1,"b":-0.5}');
  assert.throws(() => codecs.stringifyTCounts({ a: NaN }), isSerializationError);
  assert.throws(() => codecs.stringifyTSeries({ a: [1, Infinity] }), isSerializationError);
});

test('a map of numbers whose class has a toJSON that stringifies itself writes its own entries and does not overflow the stack', async (t) => {
  // protects: T-262 the native JSON writer calls toJSON, which the per-entry writer never did
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'counts.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TCountsBaseModel } from './counts.model.generated.js';
export type TCounts = IModel<{ [key: string]: number }>;
export class Counts extends TCountsBaseModel {}
`);
  writeModelGolemYaml(value.root, { mobx: false, validation: false });
  await buildModelProject(value.root);
  const codecs = await import(pathToFileURL(path.join(value.root, 'build/counts.model.generated.js')).href) as Record<string, (value: unknown) => unknown>;
  class Tally {
    a = 1;
    b = 2;
    toJSON(): unknown { return JSON.parse(codecs.stringifyTCounts(this) as string); }
  }
  assert.equal(codecs.stringifyTCounts(new Tally()), '{"a":1,"b":2}');
  assert.equal(codecs.stringifyTCounts({ a: 1, b: -0.5 }), '{"a":1,"b":-0.5}');
});
