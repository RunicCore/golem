import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';

import { createFixtureProject } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, requireRecord } from './openapi/helpers.js';
import { modelCodec } from './support/model-codec.js';

// toWireFormat of the codec of a model's class (D-105) validates when the profile does and `{ validate: false }` skips.
// A getter field of the root counts only with `allowGetter: true`.

type Model = new (values?: object) => object;
const isValidationError = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.Validation;

const sources = {
  'card.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import { TCardBaseModel, TLinkBaseModel, type TCardFields } from './card.model.generated.js';
export type TCard = IModel<{ title: string; count?: number }>;
export type TLink = IModel<{ name: string; child?: TLink }>;
export class Card extends TCardBaseModel {
  constructor(values: Partial<TCardFields> = {}) { super(values); }
}
export class Link extends TLinkBaseModel {}
`,
};

async function buildCards(t: TestContext, profile: GolemProfile) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-encode-model-', name: 'encode-model', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, sources);
  writeModelGolemYaml(root, profile);
  await buildModelProject(root);
  const models = await import(pathToFileURL(path.join(root, 'build/card.model.js')).href) as { Card: Model; Link: Model };
  return models;
}

test('the toWireFormat of a model codec validates when the profile does, and validate false skips it', async (t) => {
  // protects: D-105 toWireFormat of a model codec validates by profile; { validate: false } skips
  const { Card, Link } = await buildCards(t, { mobx: false, validation: true });
  const codec = modelCodec(Card);
  assert.deepEqual(codec.toWireFormat(new Card({ title: 'a', count: 2 })), { title: 'a', count: 2 });
  const invalid = new Card({ title: 5 });
  assert.throws(() => codec.toWireFormat(invalid), isValidationError);
  assert.deepEqual(codec.toWireFormat(invalid, { validate: false }), { title: 5 });

  class Getter extends Card { get title(): string { return 'from getter'; } }
  const getter = new Getter();
  assert.deepEqual(modelCodec(getter).toWireFormat(getter, { allowGetter: true }), { title: 'from getter' }, 'a subclass resolves its generated codec and a getter field counts with allowGetter');

  const link = new Link({ name: 'a' }) as { child?: unknown };
  link.child = link;
  for (const options of [undefined, { validate: false }]) {
    assert.throws(
      () => modelCodec(link).toWireFormat(link, options),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Serialization,
      'a cyclic model throws a LibError',
    );
  }
});

test('the toWireFormat of a model codec does not validate when the profile has validation off', async (t) => {
  // protects: D-105 the profile decides: validation off encodes without checks
  const { Card } = await buildCards(t, { mobx: false, validation: false });
  assert.deepEqual(modelCodec(Card).toWireFormat(new Card({ title: 5 })), { title: 5 });
});

test('the toWireFormat of a golem-openapi model codec validates and accepts validate false', async (t) => {
  // protects: D-105 an SDK model resolves its codec like a golem-model class
  const output = path.join(createFixtureProject(t, 'golem-openapi-encode-model-'), 'sdk');
  const item = { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } };
  const content = { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } };
  const document = {
    openapi: '3.1.0',
    info: { title: 'Items', version: '1' },
    paths: { '/items': { post: { operationId: 'createItem', requestBody: { required: true, content }, responses: { 201: { description: 'created', content } } } } },
    components: { schemas: { Item: item } },
  };
  await generateMaterializedSdk(document, { output, name: 'Items', profile: { mobx: false, validation: true, allowAny: false } });
  compileGeneratedSdk(output, [], { strict: true, skipLibCheck: true, outDir: path.join(output, 'dist') });
  const models = requireRecord(await import(pathToFileURL(path.join(output, 'dist/index.js')).href), 'generated models');
  const ItemModel = models.ItemModel as Model;
  const codec = modelCodec(ItemModel);
  assert.deepEqual(codec.toWireFormat(new ItemModel({ name: 'n' })), { name: 'n' });
  assert.throws(() => codec.toWireFormat(new ItemModel({ name: 5 })), isValidationError);
  assert.deepEqual(codec.toWireFormat(new ItemModel({ name: 5 }), { validate: false }), { name: 5 });
});

test('a validated stringify and toWireFormat, generated and through the model codec, run the predicate of a nested model once', async (t) => {
  // protects: D-105 no double validation: a nested model is not validated again inside a validated call
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-encode-once-', name: 'encode-once', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'rules.ts': `export let calls = 0;
export function positive(value: number): boolean { calls++; return value > 0; }
`,
    'money.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import type { positive } from './rules.js';
import { TMoneyBaseModel } from './money.model.generated.js';
export type TMoney = IModel<{ amount: number & TValidation<typeof positive> }>;
export class Money extends TMoneyBaseModel {}
`,
    'wallet.model.ts': `import type { IModel } from '@exprtlabs/golem/model';
import type { TMoney } from './money.model.js';
import { TWalletBaseModel } from './wallet.model.generated.js';
export type TWallet = IModel<{ money: TMoney }>;
export class Wallet extends TWalletBaseModel {}
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const rules = await import(pathToFileURL(path.join(root, 'build/rules.js')).href) as { calls: number };
  const { Money } = await import(pathToFileURL(path.join(root, 'build/money.model.js')).href) as { Money: Model };
  const { Wallet } = await import(pathToFileURL(path.join(root, 'build/wallet.model.js')).href) as { Wallet: Model };
  const { stringifyTWallet, toWireFormatTWallet } = await import(pathToFileURL(path.join(root, 'build/wallet.model.generated.js')).href) as Record<string, (value: unknown) => unknown>;
  const wallet = new Wallet({ money: new Money({ amount: 3 }) });
  const counted = (run: () => unknown): number => { const before = rules.calls; run(); return rules.calls - before; };
  assert.equal(counted(() => stringifyTWallet(wallet)), 1, 'stringify');
  assert.equal(counted(() => toWireFormatTWallet(wallet)), 1, 'toWireFormat');
  assert.equal(counted(() => modelCodec(wallet).toWireFormat(wallet)), 1, 'codec toWireFormat');
  assert.equal(counted(() => modelCodec(wallet).toWireFormat(wallet, { validate: false })), 0, 'validate false');
});
