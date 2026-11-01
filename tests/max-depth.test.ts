import 'reflect-metadata';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { valueNestsDeeperThan } from '../packages/golem/src/conversion.js';
import { NestModelInterceptor } from '@exprtlabs/golem-ts-openapi/nest';
import { nestModelCodec } from '@exprtlabs/golem-ts-openapi/internal/nest-runtime';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';

import { generatedCodecIdFromRoot } from './support/consumer.js';
import { startNestApp } from './support/nest-app.js';
import { buildRecursiveProject } from './support/recursive-fixtures.js';

// `maxDepth` bounds the object and array nesting of the input to a model that reaches a recursive model (default 512).
const sources = {
  'depth.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TLinkBaseModel, TBagBaseModel } from './depth.model.generated.js';
export type TLink = IModel<{ name: string; child?: TLink }>;
export type TBag = IModel<{ data: unknown }, { allowAny: true }>;
export class Link extends TLinkBaseModel {}
export class Bag extends TBagBaseModel {}
`,
};

/** A chain of `levels` link objects, as JSON text (`JSON.stringify` overflows the stack on a deep value) and as a value. */
function chain(levels: number): { text: string; value: { name: string; child?: unknown } } {
  let value: { name: string; child?: unknown } = { name: 'leaf' };
  for (let level = 1; level < levels; level += 1) value = { name: 'n', child: value };
  return { text: '{"name":"n","child":'.repeat(levels - 1) + '{"name":"leaf"}' + '}'.repeat(levels - 1), value };
}

const rejectsAsInput = (error: unknown): boolean =>
  error instanceof LibError && error.kind === LibErrorKind.Deserialization && error.causedByInput === true
  && /deeper than 512 levels/.test(error.message) && /maxDepth/.test(error.message);

const rejectsAsInputAt = (limit: number) => (error: unknown): boolean =>
  error instanceof LibError && error.causedByInput === true && new RegExp(`deeper than ${limit} levels`).test(error.message);

async function buildDepthProject(t: TestContext) {
  const { root } = await buildRecursiveProject(t, 'golem-max-depth-', sources, { mobx: false, validation: true });
  const { Link } = await import(pathToFileURL(path.join(root, 'build/depth.model.js')).href) as { Link: new (values: object) => object };
  return { Link, link: requireObjectCodec<{ name: string }>(generatedCodecIdFromRoot(root, 'TLink')), bag: requireObjectCodec<unknown>(generatedCodecIdFromRoot(root, 'TBag')), id: generatedCodecIdFromRoot(root, 'TLink') };
}

test('a recursive model rejects input nested beyond maxDepth on parse, fromWireFormat and assert, and validate answers false', async (t) => {
  // protects: QA a body nested ~9000 levels overflowed the stack in generated code and answered 500
  const { link } = await buildDepthProject(t);
  const atLimit = chain(512);
  const beyond = chain(513);
  const farBeyond = chain(9000);
  assert.equal(link.parse(atLimit.text).name, 'n');
  assert.equal(link.fromWireFormat(atLimit.value).name, 'n');
  assert.equal(link.validate(atLimit.value), true);
  for (const input of [beyond, farBeyond]) {
    assert.throws(() => link.parse(input.text), rejectsAsInput);
    assert.throws(() => link.fromWireFormat(input.value), rejectsAsInput);
    assert.throws(() => link.assert(input.value), rejectsAsInput);
    assert.equal(link.validate(input.value), false);
  }
});

test('maxDepth raises or lowers the bound of one call, and a value below 1 is a TypeError', async (t) => {
  // protects: QA maxDepth is a caller option with a default
  const { link } = await buildDepthProject(t);
  const deep = chain(600);
  assert.equal(link.parse(deep.text, { maxDepth: 1000 }).name, 'n');
  assert.equal(link.fromWireFormat(deep.value, { maxDepth: 1000 }).name, 'n');
  assert.equal(link.validate(deep.value, { maxDepth: 1000 }), true);
  assert.throws(() => link.parse(chain(6).text, { maxDepth: 5 }), (error: unknown) => error instanceof LibError && error.causedByInput && /deeper than 5 levels/.test(error.message));
  assert.throws(() => link.parse(chain(2).text, { maxDepth: 0 }), TypeError);
});

test('a model that reaches no recursive model is not walked, so deep unknown data is not bounded', async (t) => {
  // protects: F-159 a non-recursive model pays nothing for the depth bound
  const { bag } = await buildDepthProject(t);
  let data: unknown = 1;
  for (let level = 0; level < 1000; level += 1) data = [data];
  const text = '{"data":' + '['.repeat(1000) + '1' + ']'.repeat(1000) + '}';
  assert.equal(bag.validate({ data }), true);
  assert.equal(bag.parse(text) !== undefined, true);
  assert.equal(bag.fromWireFormat({ data }) !== undefined, true);
});

test('NestModelInterceptor answers 400 for a body nested beyond maxDepth and 201 within it, and maxDepth raises the bound', async (t) => {
  // protects: QA a deeply nested body answered 500 instead of 400
  const { id } = await buildDepthProject(t);
  class LinkController {
    handle(input: unknown) {
      return { name: (input as { name: string }).name };
    }
  }
  Controller('link')(LinkController);
  const descriptor = Object.getOwnPropertyDescriptor(LinkController.prototype, 'handle');
  Post()(LinkController.prototype, 'handle', descriptor!);
  Body()(LinkController.prototype, 'handle', 0);
  Reflect.defineMetadata('design:paramtypes', [Object], LinkController.prototype, 'handle');
  nestModelCodec(id)(LinkController.prototype, 'handle', 0);
  const post = async (application: INestApplication, text: string) => fetch(`${await application.getUrl()}/link`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: text,
  });
  const standard = await startNestApp([LinkController]);
  const raised = await startNestApp([LinkController], { interceptor: new NestModelInterceptor({ maxDepth: 600 }) });
  try {
    assert.equal((await post(standard, chain(512).text)).status, 201);
    const refused = await post(standard, chain(4000).text);
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(await refused.json()), /deeper than 512 levels/);
    assert.equal((await post(standard, chain(513).text)).status, 400);
    assert.equal((await post(raised, chain(513).text)).status, 201);
    assert.equal((await post(raised, chain(601).text)).status, 400);
  } finally {
    await standard.close();
    await raised.close();
  }
});

test('the depth walk does not list the bytes of a Uint8Array, Buffer or other class value as levels', () => {
  // protects: R-57 review finding 3 - Object.keys on a Uint8Array allocated one string per byte for every validate and assert on a recursive model
  let listed = 0;
  const watched = new Proxy(new Uint8Array(8), { ownKeys: (target) => { listed++; return Reflect.ownKeys(target); } });
  assert.equal(valueNestsDeeperThan({ bytes: watched, child: { bytes: Buffer.alloc(8_000_000) } }, 3), false);
  assert.equal(listed, 0);
  assert.equal(valueNestsDeeperThan({ at: new Date(0), list: [[[new Map([[1, 2]])]]] }, 3), true);
});

test('the depth walk visits a node that many paths share once, so a DAG of depth 30 is walked', () => {
  // protects: R-57 review finding 3 - a DAG was walked once per path, 2^30 paths for depth 30
  let shared: { left?: object; right?: object } = {};
  for (let level = 0; level < 30; level += 1) shared = { left: shared, right: shared };
  assert.equal(valueNestsDeeperThan(shared, 31), false);
  assert.equal(valueNestsDeeperThan(shared, 30), true);
});

test('the depth walk reaches the objects of a model instance, and a cycle ends the walk', async (t) => {
  // protects: R-57 review finding 3 - only arrays, plain objects and model instances are levels; an instance of a model must stay bounded
  const { Link } = await buildDepthProject(t);
  const deep = chain(10).value;
  assert.equal(valueNestsDeeperThan(new Link(deep), 5), true);
  const loop: { child?: unknown } = {};
  loop.child = loop;
  assert.equal(valueNestsDeeperThan(loop, 5), false);
});

test('allowGetter judges the depth of the root fields a getter supplies', async (t) => {
  // protects: R-57 review finding 3 - nesting below a root getter was not counted by the bound before the generated code walked it
  const { link } = await buildDepthProject(t);
  class Holder { get name(): string { return 'n'; } get child(): unknown { return chain(10).value; } }
  assert.equal(link.validate(new Holder(), { allowGetter: true, maxDepth: 5 }), false);
  assert.throws(() => link.assert(new Holder(), { allowGetter: true, maxDepth: 5 }), rejectsAsInputAt(5));
  assert.equal(link.validate(new Holder(), { allowGetter: true }), true);
});
