import { copyFixtureFile } from './fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { IssueRepresentation } from '@exprtlabs/golem/errors';
import { buildModelProject, createModelProject, writeModelGolemYaml } from './model-project.js';
import { validationFailure } from './support/validation-failure.js';

async function compile(root: string): Promise<void> {
  await buildModelProject(root);
}

function generateRoot(t: TestContext): string {
  const { root } = createModelProject(t, { prefix: 'golem-union-serde-', name: 'union-serde', linkTypescript: true });
  copyFixtureFile(root, 'models/union-serde/nested-serde/codecs.ts', 'src/codecs.ts');
  copyFixtureFile(root, 'models/union-serde/nested-serde/order.model.ts', 'src/order.model.ts');
  writeModelGolemYaml(root, { validation: true });
  return root;
}

test('nested TSerde with exact and T|T[] fail-fast reports one issue', async (t) => {
  const root = generateRoot(t);
  await compile(root);
  const codecs = await import(pathToFileURL(path.join(root, 'build/order.model.generated.js')).href) as {
    fromWireFormatTOrder: (wire: unknown, options?: { validate?: boolean; failFast?: boolean }) => {
      money: { amount: number; currency: string };
      tag?: 'open' | 'closed' | Array<'open' | 'closed'>;
    };
  };
  const loaded = codecs.fromWireFormatTOrder({
    money: { amount: '12.50', currency: 'USD' },
    tag: 'open',
  });
  assert.equal(loaded.money.amount, 12.5);
  assert.equal(loaded.tag, 'open');
  const listed = codecs.fromWireFormatTOrder({
    money: { amount: '12.50', currency: 'USD' },
    tag: ['open', 'closed'],
  });
  assert.deepEqual(listed.tag, ['open', 'closed']);
  const failFast = validationFailure(() => codecs.fromWireFormatTOrder({
    money: { amount: 1, currency: 1 },
    tag: 'refunded',
  }), 'fail-fast validation');
  assert.equal(failFast.issues.length, 1);
  assert.equal(failFast.issues[0]?.representation, IssueRepresentation.Wire);
  const exhaustive = validationFailure(() => codecs.fromWireFormatTOrder({
    money: { amount: 1, currency: 1 },
    tag: 'refunded',
  }, { failFast: false }), 'exhaustive validation');
  assert.ok(exhaustive.issues.length > 1);
  validationFailure(() => codecs.fromWireFormatTOrder({
    money: { amount: '12.50', currency: 'USD' },
    extra: true,
  }), 'exact extra-key rejection');
});
