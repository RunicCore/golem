import 'reflect-metadata';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { nestModelCodec, NestModelInterceptor } from '@exprtlabs/golem/nest';
import { requireObjectCodec } from '@exprtlabs/golem/serde';

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

async function buildDepthProject(t: TestContext) {
  const { root } = await buildRecursiveProject(t, 'golem-max-depth-', sources, { mobx: false, validation: true });
  await import(pathToFileURL(path.join(root, 'build/depth.model.js')).href);
  return { link: requireObjectCodec<{ name: string }>(generatedCodecIdFromRoot(root, 'TLink')), bag: requireObjectCodec<unknown>(generatedCodecIdFromRoot(root, 'TBag')), id: generatedCodecIdFromRoot(root, 'TLink') };
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
