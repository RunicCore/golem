import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import type { GolemProfile } from '@exprtlabs/golem/generator-api';

import { createFixtureProject } from './fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { compileGeneratedSdk, generateMaterializedSdk, requireRecord } from './openapi/helpers.js';

// encodeGeneratedModel(model, options) is the toWireFormat of the codec of the model's class (D-105): it validates when
// the profile does and `{ validate: false }` skips.

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

test('encodeGeneratedModel validates when the profile does, and validate false skips it', async (t) => {
  // protects: D-105 encodeGeneratedModel validates like toWireFormat; { validate: false } skips
  const { Card, Link } = await buildCards(t, { mobx: false, validation: true });
  assert.deepEqual(encodeGeneratedModel(new Card({ title: 'a', count: 2 }) as never), { title: 'a', count: 2 });
  const invalid = new Card({ title: 5 } as never);
  assert.throws(() => encodeGeneratedModel(invalid as never), isValidationError);
  assert.deepEqual(encodeGeneratedModel(invalid as never, { validate: false }), { title: 5 });

  class Getter extends Card { get title(): string { return 'from getter'; } }
  assert.deepEqual(encodeGeneratedModel(new Getter() as never), { title: 'from getter' }, 'a subclass resolves its generated codec and a getter field counts while validation runs');

  const link = new Link({ name: 'a' } as never) as { child?: unknown };
  link.child = link;
  for (const options of [undefined, { validate: false }]) {
    assert.throws(
      () => encodeGeneratedModel(link as never, options),
      (error: unknown) => error instanceof LibError && error.kind === LibErrorKind.Serialization,
      'a cyclic model throws a LibError',
    );
  }
});

test('encodeGeneratedModel does not validate when the profile has validation off', async (t) => {
  // protects: D-105 the profile decides: validation off encodes without checks
  const { Card } = await buildCards(t, { mobx: false, validation: false });
  assert.deepEqual(encodeGeneratedModel(new Card({ title: 5 } as never) as never), { title: 5 });
});

test('encodeGeneratedModel of a golem-openapi model validates and accepts validate false', async (t) => {
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
  assert.deepEqual(encodeGeneratedModel(new ItemModel({ name: 'n' }) as never), { name: 'n' });
  assert.throws(() => encodeGeneratedModel(new ItemModel({ name: 5 }) as never), isValidationError);
  assert.deepEqual(encodeGeneratedModel(new ItemModel({ name: 5 }) as never, { validate: false }), { name: 5 });
});

test('a validated stringify, toWireFormat and encodeGeneratedModel run the predicate of a nested model once', async (t) => {
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
  assert.equal(counted(() => encodeGeneratedModel(wallet as never)), 1, 'encodeGeneratedModel');
  assert.equal(counted(() => encodeGeneratedModel(wallet as never, { validate: false })), 0, 'validate false');
});
