import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { createFixtureProject } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { compileGeneratedSdk, generateMaterializedSdk } from './openapi/helpers.js';
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

type Codec = (value: unknown, options?: object) => unknown;
type Codecs = Record<string, Codec>;

/** Compare wire values as JSON data; prototype and absent-field details belong to the wire-format suite. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const profiles: readonly (readonly [string, GolemProfile])[] = [
  ['validation off', { mobx: false, validation: false }],
  ['validation on', { mobx: false, validation: true }],
];

for (const [label, profile] of profiles) {
  test(`self- and mutually recursive models generate and round-trip (${label})`, async (t: TestContext) => {
    const { root, sourceRoot } = createModelProject(t, {
      prefix: 'golem-recursive-models-', linkTypescript: true,
    });
    writeModelSources(sourceRoot, sources);
    writeModelGolemYaml(root, profile);
    await buildModelProject(root);
    const codecs = await import(pathToFileURL(path.join(root, 'build/tree.model.generated.js')).href) as Codecs;

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
