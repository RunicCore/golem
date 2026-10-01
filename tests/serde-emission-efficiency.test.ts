import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import type { GeneratedModel } from '@exprtlabs/golem/model';
import { generateModels } from '#openapi/models';
import { writeSdk } from '#openapi/generator';
import { generate } from '#model/generator';
import { compileModelProject, createModelProject } from './model-project.js';
import { writeGeneratedSdk } from './openapi/helpers.js';

const fixture = (t: TestContext) => createModelProject(t, {
  prefix: 'golem-serde-emission-',
  name: 'serde-emission-efficiency',
});

function modelArtifact(result: ReturnType<typeof generate>, name: string): string {
  return result.artifacts.find((artifact) => artifact.path.endsWith(`/${name}.model.generated.ts`))?.content ?? '';
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `generated function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `end of generated function ${name}`);
  return source.slice(start, end);
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
    profile: { mobx: false, validation: false, ajvStandalone: false, allowAny: false },
  });
  writeFileSync(path.join(value.sourceRoot, 'wallet.model.ts'), readFixture("models/serde-emission-efficiency/model-generation-preserves-imported-model-identity-and-detached-json-output/wallet.model.ts"));

  const result = generate({
    root: value.root,
    sources: [path.join(value.sourceRoot, 'wallet.model.ts')],
    manifestInputs: [path.join(sdk, 'model-manifest.json')],
    profile: { mobx: false, validation: false },
  });
  const generated = modelArtifact(result, 'wallet');
  assert.match(generated, /decodeGeneratedModelTrusted/, 'budget: decoding an already-known external model uses the trusted fast path');
  assert.match(generated, /encodeGeneratedModel/, 'budget: encoding an external model reuses the shared encodeGeneratedModel helper');
  assert.match(generated, /stringifyMoney\(/, 'one stringify function per interned node: wallet calls stringifyMoney instead of inlining it');
  assert.doesNotMatch(
    generated,
    /requireObjectCodec\("Money"\)\.stringify/,
    'budget: a known Money codec is stringified by direct call, not a runtime requireObjectCodec lookup',
  );
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(value.root);

  const sdkModule = await import(pathToFileURL(path.join(value.root, 'build/sdk/index.js')).href) as {
    readonly MoneyModel: new (values?: { amount?: number; currency?: string }) => object;
  };
  const walletModule = await import(pathToFileURL(path.join(value.root, 'build/wallet.model.js')).href) as {
    readonly Wallet: new (values?: { money?: object }) => object;
  };
  const serde = await import('@exprtlabs/golem/serde');
  const wallet = await decodeGeneratedModel(walletModule.Wallet, {
    money: { amount: 7, currency: 'USD' },
  }) as { readonly money: object };
  assert.ok(wallet.money instanceof sdkModule.MoneyModel, 'external model is reconstructed as a concrete instance');
  const wire = await encodeGeneratedModel(wallet as never) as { readonly money: object };
  const text = JSON.stringify(wire);
  assert.notStrictEqual(wire.money, wallet.money, 'wire output is detached from the external model');
  assert.equal(text, '{"money":{"amount":7,"currency":"USD"}}');
});

test('model decoder leaves unchanged fields in the initializer copy', (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'item.model.ts'), readFixture("models/serde-emission-efficiency/model-decoder-leaves-unchanged-fields-in-the-initializer-copy/item.model.ts"));
  copyFixtureFile(
    value.root,
    'models/serde-emission-efficiency/model-decoder-leaves-unchanged-fields-in-the-initializer-copy/codecs.ts',
    'src/codecs.ts',
  );

  const result = generate({ root: value.root, profile: { mobx: false, validation: false } });
  const decode = functionBody(modelArtifact(result, 'item'), 'decodeTItemModel');
  assert.match(
    decode,
    /const result: Record<string, unknown> = \{ \.\.\.values \};/,
    'budget: decode starts from a shallow copy of the wire values instead of building the object key by key',
  );
  assert.doesNotMatch(
    decode,
    /defineModelProperty\(result, "title"/,
    'budget: an unchanged field is left in the copy, not redefined through defineModelProperty',
  );
  assert.match(
    decode,
    /defineModelProperty\(result, "code"/,
    'budget: a field with a codec is redefined through defineModelProperty, unlike the unchanged title field',
  );
});

test('generated decoding preserves the constructor and initializer boundaries', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'child.model.ts'), readFixture("models/serde-emission-efficiency/generated-decoding-preserves-the-constructor-and-initializer-boundaries/child.model.ts"));
  writeFileSync(path.join(value.sourceRoot, 'optional-codec.ts'), readFixture("models/serde-emission-efficiency/generated-decoding-preserves-the-constructor-and-initializer-boundaries/optional-codec.ts"));
  writeFileSync(path.join(value.sourceRoot, 'parent.model.ts'), readFixture("models/serde-emission-efficiency/generated-decoding-preserves-the-constructor-and-initializer-boundaries/parent.model.ts"));

  const result = generate({ root: value.root, profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(value.root);
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
  await compileModelProject(value.root);

  const models = await import(pathToFileURL(path.join(value.root, 'build/models.js')).href) as unknown as {
    readonly ChildModel: new (values?: Record<string, unknown>) => object;
    readonly ParentModel: new (values?: Record<string, unknown>) => object;
  };
  const child = new models.ChildModel({ value: 'child' });
  const parent = new models.ParentModel({ title: 'parent', child, labels: ['one', 'two'] });
  const wire = encodeGeneratedModel(parent as GeneratedModel<unknown>);
  const text = JSON.stringify(wire);
  assert.equal(text, '{"title":"parent","child":{"value":"child"},"labels":["one","two"]}');
});

test('OpenAPI decoder leaves scalar fields in the initializer copy', () => {
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
          },
        },
      },
    },
  }, { mobx: false, validation: false });
  const decode = functionBody(source, 'deserializeParentFields');
  assert.match(
    decode,
    /const result: Record<string, unknown> = \{ \.\.\.value \};/,
    'budget: decode starts from a shallow copy of the wire value instead of building the object key by key',
  );
  assert.doesNotMatch(
    decode,
    /result\["title"\]/,
    'budget: the unconverted scalar title field is left in the copy, not individually assigned',
  );
  assert.match(
    decode,
    /result\["child"\]/,
    'budget: the nested $ref field is individually converted, unlike the unconverted scalar title field',
  );
  const child = functionBody(source, 'deserializeChildFields');
  assert.doesNotMatch(
    child,
    /\{ \.\.\.value \}/,
    'budget: a model with no converted fields casts the input directly instead of copying it',
  );
  assert.match(
    child,
    /return value as ChildInit/,
    'budget: pairs with the no-copy check above — the input is cast and returned directly, not rebuilt field by field',
  );
});

test('nested local models decode from the already isolated input without copying it again', async (t) => {
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
  const result = generate({ root: value.root, profile: { mobx: false, validation: false } });
  const generated = modelArtifact(result, 'team');
  // Only the outermost call copies the input; nested models reuse that copy.
  assert.doesNotMatch(functionBody(generated, 'fillTTeam'), /fromWireFormat(Member|Stamp)\(/);
  assert.match(functionBody(generated, 'fillTTeam'), /convertFromWireTMember\([^;]*, true\)/);
  assert.match(functionBody(generated, 'fillTMember'), /convertFromWireTStamp\([^;]*, true\)/);

  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(value.root);
  const { Team } = await import(pathToFileURL(path.join(value.root, 'build/team.model.js')).href);
  // Nested values are the generated classes; a model file's own subclasses aren't visible to its companion.
  const { TMemberBaseModel: Member, TStampBaseModel: Stamp } = await import(pathToFileURL(path.join(value.root, 'build/team.model.generated.js')).href);
  const { requireObjectCodec } = await import('@exprtlabs/golem/serde');
  const input = { lead: { name: 'Ada', joined: { time: 1 } }, members: [{ name: 'Lin', joined: { time: 2 } }] };
  const codec = requireObjectCodec<InstanceType<typeof Team>>('TTeam');
  for (const team of [codec.fromWireFormat(input, { construct: Team }), codec.parse(JSON.stringify(input), { construct: Team })] as Record<string, any>[]) {
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
});

test('model encoding assigns present fields in declaration order without deleting keys', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.sourceRoot, 'note.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import { TNoteBaseModel } from './note.model.generated.js';
export type TNote = IModel<{ title: string; body?: string; pinned: boolean }>;
export class Note extends TNoteBaseModel {}
`);
  const result = generate({ root: value.root, profile: { mobx: false, validation: false } });
  const generated = modelArtifact(result, 'note');
  const encode = functionBody(generated, 'encodeTNoteModel');
  assert.doesNotMatch(generated, /AbsentField/, 'budget: no sentinel value stands in for an absent field');
  assert.doesNotMatch(encode, /\bdelete\b/, 'budget: absent fields are never added and then deleted, which turns the result into a dictionary-mode object');
  const positions = ['title', 'body', 'pinned'].map((name) => encode.indexOf(`defineModelProperty(result, "${name}"`));
  assert.ok(positions.every((position) => position >= 0), 'every field is assigned conditionally');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'fields are assigned in declaration order');

  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(value.root);
  const { Note } = await import(pathToFileURL(path.join(value.root, 'build/note.model.js')).href);
  const keys = (init: object) => Object.keys(encodeGeneratedModel(new Note(init) as never));
  assert.deepEqual(keys({ title: 't', pinned: true }), ['title', 'pinned']);
  assert.deepEqual(keys({ title: 't', body: undefined, pinned: true }), ['title', 'pinned'], 'an undefined optional field is omitted');
  assert.deepEqual(keys({ pinned: false, body: 'b', title: 't' }), ['title', 'body', 'pinned'], 'declaration order, not initializer order');
  assert.deepEqual(encodeGeneratedModel(new Note({ title: 't', body: 'b', pinned: false }) as never), { title: 't', body: 'b', pinned: false });
});
