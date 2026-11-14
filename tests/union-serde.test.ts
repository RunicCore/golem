import { copyFixtureFile } from './fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { IssueRepresentation } from '@exprtlabs/golem/errors';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
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

test('a class whose TSerde reads an array wire form beside another array stops generation', async (t) => {
  // protects: T-905 the class was no sequence for the union, so an array wire value took the other array and the serde never read it
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-union-serde-array-wire-', name: 'union-serde-array-wire', linkTypescript: true });
  writeModelGolemYaml(root, { validation: false });
  writeModelSources(sourceRoot, {
    'codecs.ts': `export class Point { constructor(readonly x: number, readonly y: number) {} }
export const writePoint = (point: Point): [number, number] => [point.x, point.y];
export const readPoint = (wire: [number, number]): Point => new Point(wire[0], wire[1]);
`,
    'box.model.ts': `import type { IObject } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import type { Point, writePoint, readPoint } from './codecs.js';
export type TBox = IObject<{ items: (Point & TSerde<typeof writePoint, typeof readPoint>) | { code: string }[] }>;
`,
  });
  await assert.rejects(() => compile(root), /Union has ambiguous conversions/);
});
