import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { writeSdk } from '#openapi/generator';
import { createFixtureProject } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { buildRecursiveProject, importCodecs, json, type Codec, type Codecs } from './support/recursive-fixtures.js';
import { compileGeneratedSdk, generateMaterializedSdk, writeGeneratedSdk } from './openapi/helpers.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';

const sources = {
  'tree.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TNodeBaseModel, TLeftBaseModel, TRightBaseModel } from './tree.model.generated.js';
export type TNode = IModel<{ at: Date; children: TNode[] }>;
export type TLeft = IModel<{ at: Date; right?: TRight }>;
export type TRight = IModel<{ at: Date; lefts: TLeft[] }>;
export class Node extends TNodeBaseModel {}
export class Left extends TLeftBaseModel {}
export class Right extends TRightBaseModel {}
`,
};

const profiles: readonly (readonly [string, GolemProfile])[] = [
  ['validation off', { mobx: false, validation: false }],
  ['validation on', { mobx: false, validation: true }],
];

for (const [label, profile] of profiles) {
  test(`self- and mutually recursive models generate and round-trip (${label})`, async (t: TestContext) => {
    const { root } = await buildRecursiveProject(t, 'golem-recursive-models-', sources, profile);
    const codecs = await importCodecs(root, 'tree');

    const nodeWire = { at: '2024-01-01T00:00:00.000Z', children: [{ at: '2024-01-02T00:00:00.000Z', children: [{ at: '2024-01-03T00:00:00.000Z', children: [] }] }] };
    const node = codecs.fromWireFormatTNode(nodeWire) as { children: { children: { at: unknown }[] }[] };
    assert.ok(node.children[0].children[0].at instanceof Date, 'nested dates decode at every depth');
    assert.deepEqual(json(codecs.toWireFormatTNode(node)), nodeWire);
    assert.equal(codecs.stringifyTNode(node), JSON.stringify(nodeWire));
    assert.deepEqual(json(codecs.toWireFormatTNode(codecs.parseTNode(JSON.stringify(nodeWire)))), nodeWire);

    const leftWire = { at: '2024-01-01T00:00:00.000Z', right: { at: '2024-01-02T00:00:00.000Z', lefts: [{ at: '2024-01-03T00:00:00.000Z' }] } };
    const left = codecs.fromWireFormatTLeft(leftWire) as { right: { lefts: { at: unknown }[] } };
    assert.ok(left.right.lefts[0].at instanceof Date);
    assert.equal(codecs.stringifyTLeft(left), JSON.stringify(leftWire));
    assert.deepEqual(json(codecs.toWireFormatTLeft(left)), leftWire);

    if (profile.validation) {
      assert.equal(codecs.validateTNode(node), true);
      const invalid = { at: new Date(), children: [{ at: new Date(), children: [{ at: 'not a date', children: [] }] }] };
      assert.equal(codecs.validateTNode(invalid), false, 'validation reaches recursive children');
      assert.throws(() => codecs.fromWireFormatTNode({ at: '2024-01-01T00:00:00.000Z', children: [{ at: 5, children: [] }] }));
    }
    const generated = fs.readFileSync(path.join(root, 'src/tree.model.generated.ts'), 'utf8');
    assert.ok(generated.length < 400_000, `recursive models do not expand inline (${generated.length} bytes)`);
  });
}

const cycleSources = {
  'chain.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TLinkBaseModel, TBagBaseModel, THolderBaseModel } from './chain.model.generated.js';
export type TLink = IModel<{ name: string; child?: TLink }>;
export type TBag = IModel<{ data: unknown }, { allowAny: true }>;
export type THolder = IModel<{ link: TLink }>;
export class Holder extends THolderBaseModel {}
export class Link extends TLinkBaseModel {}
export class Bag extends TBagBaseModel {}
`,
};

for (const [label, profile] of profiles) {
  test(`encoding a cyclic value throws a Serialization LibError, and shared or deep values still encode (${label})`, async (t: TestContext) => {
    // protects: T-165 stringify and toWireFormat of a cyclic value throw a LibError
    const { root, sourceRoot } = createModelProject(t, {
      prefix: 'golem-encode-cycle-', linkTypescript: true,
    });
    writeModelSources(sourceRoot, cycleSources);
    writeModelGolemYaml(root, profile);
    await buildModelProject(root);
    const codecs = await import(pathToFileURL(path.join(root, 'build/chain.model.generated.js')).href) as Codecs;

    const selfLink: { name: string; child?: unknown } = { name: 'a' };
    selfLink.child = selfLink;
    const farLink = { name: 'a', child: { name: 'b', child: { name: 'c' } as { name: string; child?: unknown } } };
    farLink.child.child.child = farLink;
    const cyclicData: Record<string, unknown> = { at: 1 };
    cyclicData.back = cyclicData;
    const cyclicList: unknown[] = [{ ok: true }];
    cyclicList.push(cyclicList);

    const isSerializationError = (error: unknown): boolean =>
      error instanceof LibError && error.kind === LibErrorKind.Serialization && error.causedByInput === false;
    const encoders: readonly (readonly [string, Codec])[] = [
      ['stringifyTLink', codecs.stringifyTLink], ['toWireFormatTLink', codecs.toWireFormatTLink],
      ['stringifyTBag', codecs.stringifyTBag], ['toWireFormatTBag', codecs.toWireFormatTBag],
      ['stringifyTHolder', codecs.stringifyTHolder], ['toWireFormatTHolder', codecs.toWireFormatTHolder],
    ];
    const cyclicInputs: readonly (readonly [string, unknown])[] = [
      ['stringifyTLink', selfLink], ['toWireFormatTLink', selfLink],
      ['stringifyTLink', farLink], ['toWireFormatTLink', farLink],
      ['stringifyTHolder', { link: selfLink }], ['toWireFormatTHolder', { link: selfLink }],
      ['stringifyTBag', { data: cyclicData }], ['toWireFormatTBag', { data: cyclicData }],
      ['stringifyTBag', { data: cyclicList }], ['toWireFormatTBag', { data: cyclicList }],
    ];
    for (const [name, input] of cyclicInputs) {
      const encode = encoders.find(([encoder]) => encoder === name)![1];
      assert.throws(() => encode(input), isSerializationError, `${name} throws a Serialization LibError on a cycle`);
    }

    // A value reached twice without a cycle, and a long chain, encode.
    const shared = { name: 's' };
    const dag = { name: 'a', child: { name: 'b', child: shared } };
    assert.equal(codecs.stringifyTLink(dag), JSON.stringify(dag));
    const sharedData = { n: 1 };
    const dagBag = { data: { left: sharedData, right: sharedData, list: [sharedData, sharedData] } };
    assert.equal(codecs.stringifyTHolder({ link: dag }), JSON.stringify({ link: dag }));
    assert.equal(codecs.stringifyTBag(dagBag), JSON.stringify(dagBag));
    assert.deepEqual(json(codecs.toWireFormatTBag(dagBag)), dagBag);
    let chain: { name: string; child?: unknown } = { name: 'n0' };
    for (let index = 1; index < 300; index += 1) chain = { name: `n${index}`, child: chain };
    assert.equal(codecs.stringifyTLink(chain), JSON.stringify(chain));
    assert.deepEqual(json(codecs.toWireFormatTLink(chain)), json(chain));
  });
}

const crossFileSources = {
  'chain.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TChainBaseModel } from './chain.model.generated.js';
export type TChain = IModel<{ name: string; next?: TChain }>;
export class Chain extends TChainBaseModel {}
`,
  'owner.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TChain } from './chain.model.js';
import { TOwnerBaseModel } from './owner.model.generated.js';
export type TOwner = IModel<{ chain: TChain }>;
export class Owner extends TOwnerBaseModel {}
`,
};

for (const [label, profile] of profiles) {
  test(`a model that holds a recursive model of another file throws a Serialization LibError on a cycle (${label})`, async (t: TestContext) => {
    // protects: T-165 the parent of a cross-file recursive child still checks for a cycle before its validator runs
    const { root, sourceRoot } = createModelProject(t, {
      prefix: 'golem-encode-cycle-files-', linkTypescript: true,
    });
    writeModelSources(sourceRoot, crossFileSources);
    writeModelGolemYaml(root, profile);
    await buildModelProject(root);
    const owner = await import(pathToFileURL(path.join(root, 'build/owner.model.generated.js')).href) as Codecs;

    const chain: { name: string; next?: unknown } = { name: 'a' };
    chain.next = chain;
    for (const encode of [owner.stringifyTOwner, owner.toWireFormatTOwner]) {
      assert.throws(() => encode({ chain }), (error: unknown) =>
        error instanceof LibError && error.kind === LibErrorKind.Serialization && error.causedByInput === false);
    }
    const acyclic = { chain: { name: 'a', next: { name: 'b' } } };
    assert.equal(owner.stringifyTOwner(acyclic), JSON.stringify(acyclic));
  });
}

const chainedFileSources = {
  'link.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TLinkBaseModel } from './link.model.generated.js';
export type TLink = IModel<{ name: string; next?: TLink }>;
export class Link extends TLinkBaseModel {}
`,
  'middle.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TLink } from './link.model.js';
import { TMiddleBaseModel } from './middle.model.generated.js';
export type TMiddle = IModel<{ link: TLink }>;
export class Middle extends TMiddleBaseModel {}
`,
  'top.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TMiddle } from './middle.model.js';
import { TTopBaseModel } from './top.model.generated.js';
export type TTop = IModel<{ middle: TMiddle }>;
export class Top extends TTopBaseModel {}
`,
};

test('a model two files away from a recursive model throws a Serialization LibError on a cycle', async (t: TestContext) => {
  // protects: T-165 a model that reaches a recursive model through a non-recursive file still checks for a cycle
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-encode-cycle-chain-', linkTypescript: true });
  writeModelSources(sourceRoot, chainedFileSources);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const top = await import(pathToFileURL(path.join(root, 'build/top.model.generated.js')).href) as Codecs;

  const link: { name: string; next?: unknown } = { name: 'a' };
  link.next = link;
  for (const encode of [top.stringifyTTop, top.toWireFormatTTop]) {
    assert.throws(() => encode({ middle: { link } }), (error: unknown) =>
      error instanceof LibError && error.kind === LibErrorKind.Serialization && error.causedByInput === false);
  }
  const acyclic = { middle: { link: { name: 'a', next: { name: 'b' } } } };
  assert.equal(top.stringifyTTop(acyclic), JSON.stringify(acyclic));
});

const isSerializationError = (error: unknown): boolean =>
  error instanceof LibError && error.kind === LibErrorKind.Serialization && error.causedByInput === false;

// An expression tree: a leaf, or a branch whose children are again expressions. In golem-model a union is a field
// type and never a codec of its own; only an OpenAPI oneOf component whose variants share a base is a union model.
const nestedBranch = { kind: 'branch', children: [{ kind: 'leaf', value: 1 }, { kind: 'branch', children: [{ kind: 'branch', children: [{ kind: 'leaf', value: 2 }] }] }] };

const unionDocument = {
  openapi: '3.1.0',
  info: { title: 'Expr', version: '1' },
  paths: {},
  components: {
    schemas: {
      Base: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
      Leaf: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', required: ['value'], properties: { value: { type: 'number' } } }] },
      Branch: {
        allOf: [{ $ref: '#/components/schemas/Base' }, {
          type: 'object',
          required: ['children'],
          properties: { children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } },
        }],
      },
      Node: {
        oneOf: [{ $ref: '#/components/schemas/Leaf' }, { $ref: '#/components/schemas/Branch' }],
        discriminator: {
          propertyName: 'kind',
          mapping: { leaf: '#/components/schemas/Leaf', branch: '#/components/schemas/Branch' },
        },
      },
      Owner: { type: 'object', required: ['root'], properties: { root: { $ref: '#/components/schemas/Node' } } },
    },
  },
};

for (const validation of [false, true]) {
  test(`a recursive oneOf model encodes a nested branch and still throws on a cycle (validation ${validation ? 'on' : 'off'})`, async (t: TestContext) => {
    // protects: T-165 a recursive union encodes a nested value and a real cycle still throws
    const output = path.join(createFixtureProject(t, 'golem-openapi-recursive-union-'), 'sdk');
    await generateMaterializedSdk(unionDocument, { output, name: 'Expr', profile: { mobx: false, validation, allowAny: false } });
    compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true });
    await import(pathToFileURL(path.join(output, 'dist/index.js')).href);
    type Encoder = { stringify(value: unknown): string; toWireFormat(value: unknown): unknown };
    const branch = requireObjectCodec<object>(generatedCodecIdFromRoot(output, 'Branch')) as unknown as Encoder;
    const owner = requireObjectCodec<object>(generatedCodecIdFromRoot(output, 'Owner')) as unknown as Encoder;

    assert.equal(branch.stringify(nestedBranch), JSON.stringify(nestedBranch));
    assert.deepEqual(json(branch.toWireFormat(nestedBranch)), nestedBranch);
    assert.equal(owner.stringify({ root: nestedBranch }), JSON.stringify({ root: nestedBranch }));
    assert.deepEqual(json(owner.toWireFormat({ root: nestedBranch })), { root: nestedBranch });

    const cyclic: { kind: string; children: unknown[] } = { kind: 'branch', children: [] };
    cyclic.children.push({ kind: 'branch', children: [cyclic] });
    for (const encode of [(value: unknown) => branch.stringify(value), (value: unknown) => branch.toWireFormat(value)]) {
      assert.throws(() => encode(cyclic), isSerializationError);
    }
  });
}

const sdkHolderSources = {
  'holder.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { Link, Money } from './sdk/types.js';
import { TWalletBaseModel, TChainHolderBaseModel } from './holder.model.generated.js';
export type TWallet = IModel<{ money: Money }>;
export type TChainHolder = IModel<{ link: Link }>;
export class Wallet extends TWalletBaseModel {}
export class ChainHolder extends TChainHolderBaseModel {}
`,
};

const sdkDocument = {
  openapi: '3.1.0',
  info: { title: 'Held models', version: '1' },
  components: {
    schemas: {
      Money: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } },
      Link: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, next: { $ref: '#/components/schemas/Link' } } },
    },
  },
};

test('a model that holds an SDK model walks for cycles only when that model is recursive', async (t: TestContext) => {
  // protects: T-165 a parent of a non-recursive SDK model pays no cycle walk; a recursive SDK model still throws on a cycle
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-sdk-recursion-', linkTypescript: true });
  writeGeneratedSdk(writeSdk, sdkDocument, { output: path.join(sourceRoot, 'sdk'), profile: { mobx: false, validation: true, allowAny: false } });
  writeModelSources(sourceRoot, sdkHolderSources);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const generated = fs.readFileSync(path.join(root, 'src/holder.model.generated.ts'), 'utf8');
  const walkers = [...generated.matchAll(/^(?:export )?function (\w+)\([^)]*\)[^{]*\{\n(?:(?!^\}).*\n)*?\s+assertAcyclicEncodeInput\(/gm)].map(match => match[1]);
  assert.deepEqual(walkers.filter(name => name.endsWith('TWallet')), [], 'the wallet holds a Money model that never reaches itself');
  assert.ok(walkers.some(name => name.endsWith('TChainHolder')), 'the holder of a recursive Link walks for cycles before its validator');

  const codecs = await import(pathToFileURL(path.join(root, 'build/holder.model.generated.js')).href) as Codecs;
  const link: { name: string; next?: unknown } = { name: 'a' };
  link.next = link;
  for (const encode of [codecs.stringifyTChainHolder, codecs.toWireFormatTChainHolder]) {
    assert.throws(() => encode({ link }), isSerializationError);
  }
  assert.equal(codecs.stringifyTWallet({ money: { amount: 1 } }), '{"money":{"amount":1}}');
});

const inlineUnionSources = {
  'expr.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TBranchBaseModel } from './expr.model.generated.js';
export type TLeaf = IModel<{ kind: 'leaf'; value: string }>;
export type TBranch = IModel<{ kind: 'branch'; children: (TLeaf | TBranch)[] }>;
export class Branch extends TBranchBaseModel {}
`,
};

test('a recursive inline discriminated union generates with validation on and judges every depth', async (t: TestContext) => {
  // protects: T-199 a recursive tagged union of models builds with validation on instead of overflowing the stack
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-recursive-inline-union-', linkTypescript: true });
  writeModelSources(sourceRoot, inlineUnionSources);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const codecs = await import(pathToFileURL(path.join(root, 'build/expr.model.generated.js')).href) as Codecs;
  const tree = (value: unknown) => ({ kind: 'branch', children: [{ kind: 'branch', children: [{ kind: 'branch', children: [{ kind: 'leaf', value }] }] }] });
  assert.equal(codecs.validateTBranch(tree('a')), true);
  assert.deepEqual(json(codecs.parseTBranch(JSON.stringify(tree('a')))), tree('a'));
  assert.equal(codecs.validateTBranch(tree(1)), false, 'a bad leaf three levels deep fails');
  assert.throws(() => codecs.parseTBranch(JSON.stringify(tree(1))), (error: unknown) => error instanceof LibError && error.causedByInput === true);
});

// A recursive alias of any shape is one named function: a union, a tuple, a record, and the JSON value type.
const aliasSources = {
  'alias.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
export type TItem = string | TItem[];
export type Tree = [string, Tree[]];
export type Registry = { [key: string]: Registry };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TLeaf = IModel<{ name: string }>;
export type Mixed = TLeaf | Mixed[];
export type TShelf = IModel<{ item: TItem }>;
export type TDoc = IModel<{ tree: Tree; registry: Registry; payload: JsonValue; extra?: JsonValue; list: JsonValue[]; items: JsonValue[][] }>;
export type TBox = IModel<{ mixed: Mixed }>;
`,
};
const shelfWire = { item: ['a', ['b', ['c']], 'd'] };
const docWire = {
  tree: ['root', [['left', []], ['right', [['leaf', []]]]]],
  registry: { a: { b: {} }, c: {} },
  payload: { n: [1, 'two', null, true, { deep: [false] }] },
  extra: [null, { k: 'v' }],
  list: [1, 'x', [2], { y: 3 }],
  items: [[1], ['a', { b: null }]],
};

for (const [label, profile] of profiles) {
  test(`a recursive alias of a union, a tuple, a record and a JSON value generates and round-trips (${label})`, async (t: TestContext) => {
    // protects: T-221 a recursive type alias of any shape generates, validates and converts
    const { root } = await buildRecursiveProject(t, 'golem-recursive-alias-', aliasSources, profile);
    const codecs = await importCodecs(root, 'alias');
    const generated = fs.readFileSync(path.join(root, 'src/alias.model.generated.ts'), 'utf8');

    for (const [wire, name] of [[shelfWire, 'TShelf'], [docWire, 'TDoc']] as const) {
      const model = codecs[`fromWireFormat${name}`](wire);
      assert.deepEqual(json(model), wire, `${name} decodes`);
      assert.deepEqual(json(codecs[`toWireFormat${name}`](model)), wire, `${name} encodes`);
      assert.equal(codecs[`stringify${name}`](model), JSON.stringify(wire), `${name} stringifies`);
      assert.deepEqual(json(codecs[`parse${name}`](JSON.stringify(wire))), wire, `${name} parses`);
    }
    if (profile.validation) {
      const validators = await import(pathToFileURL(path.join(root, 'build/generated/models/models.validators.generated.js')).href) as Record<string, (value: unknown, collectAll?: boolean) => unknown>;
      const jsonId = Object.keys(validators).find((name) => /^is_JsonValue_/.test(name))!.slice('is_'.length);
      const isJson = validators[`is_${jsonId}`] as (value: unknown) => boolean;
      const issuesOf = validators[`validate_${jsonId}`] as (value: unknown, collectAll: boolean) => readonly unknown[];
      const deep = (leaf: unknown): unknown => ({ a: [{ b: leaf }] });
      assert.equal(isJson(deep('ok')), true);
      assert.equal(issuesOf(deep('ok'), true).length, 0);
      for (const bad of [() => 1, Symbol('x'), 5n]) {
        assert.equal(isJson(deep(bad)), false, 'a bad leaf three levels deep fails the fast check');
        assert.equal(issuesOf(deep(bad), true).length > 0, true, 'and the collecting validator');
      }
      assert.equal(codecs.validateTDoc(codecs.fromWireFormatTDoc(docWire)), true);
      assert.throws(() => codecs.fromWireFormatTDoc({ ...docWire, payload: deep(Symbol('x')) }));
      assert.throws(() => codecs.fromWireFormatTDoc({ ...docWire, tree: ['root', [['left', [1]]]] }), 'a tuple slot of the wrong type fails');
      assert.throws(() => codecs.fromWireFormatTShelf({ item: ['a', [3]] }));
    }
  });

  test(`a cyclic value in a field of a recursive alias throws a Serialization LibError, and a union of a named model and an array encodes (${label})`, async (t: TestContext) => {
    // protects: T-221 a recursive alias never overflows the stack on a cyclic value, and encodes a valid named model beside an array
    const { root } = await buildRecursiveProject(t, 'golem-recursive-alias-cycle-', aliasSources, profile);
    const codecs = await importCodecs(root, 'alias');
    const doc = (payload: unknown) => ({ tree: ['t', []], registry: {}, payload, list: [], items: [] });

    const cyclicList: unknown[] = [1];
    cyclicList.push(cyclicList);
    const cyclicRecord: Record<string, unknown> = { a: 1 };
    cyclicRecord.back = { inner: [cyclicRecord] };
    for (const payload of [cyclicList, cyclicRecord]) {
      for (const encode of [codecs.stringifyTDoc, codecs.toWireFormatTDoc]) {
        assert.throws(() => encode(doc(payload)), isSerializationError, 'a cyclic payload');
      }
    }
    const shared = { n: 1 };
    const dag = doc({ left: shared, right: [shared, shared] });
    assert.equal(codecs.stringifyTDoc(dag), JSON.stringify(dag));

    const mixed = [{ name: 'a' }, [{ name: 'b' }, [{ name: 'c' }]]];
    const model = codecs.fromWireFormatTBox({ mixed });
    assert.deepEqual(json(codecs.toWireFormatTBox(model)), { mixed });
    assert.equal(codecs.stringifyTBox({ mixed }), JSON.stringify({ mixed }));
  });
}
