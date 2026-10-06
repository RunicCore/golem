import { copyFixtureFile, createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from './fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import { IssueRepresentation, LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { workspace } from './support/process.js';
import { buildModelProject, writeModelGolemYaml } from './model-project.js';

async function compile(root: string): Promise<void> {
  await buildModelProject(root);
}

function generateRoot(t: TestContext): string {
  const root = createFixtureProject(t, 'golem-union-serde-');
  linkProjectPackages(root, {
    '@exprtlabs/golem': path.join(workspace, 'packages/golem'),
    typescript: path.join(workspace, 'node_modules/typescript'),
  });
  writeGeneratedArtifacts([
    {
      path: path.join(root, 'package.json'),
      content: JSON.stringify({ name: 'union-serde', private: true, type: 'module' }),
    },
    {
      path: path.join(root, 'tsconfig.json'),
      content: JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
          outDir: 'build',
          rootDir: 'src',
        },
        include: ['src/**/*.ts'],
      }),
    },
  ]);
  copyFixtureFile(root, 'models/union-serde/nested-serde/codecs.ts', 'src/codecs.ts');
  copyFixtureFile(root, 'models/union-serde/nested-serde/order.model.ts', 'src/order.model.ts');
  writeModelGolemYaml(root, { mobx: false, validation: true });
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
  try {
    codecs.fromWireFormatTOrder({
      money: { amount: 1, currency: 1 },
      tag: 'refunded',
    });
    assert.fail('expected fail-fast validation');
  } catch (error) {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Validation);
    assert.equal(error.issues.length, 1);
    assert.equal(error.issues[0]?.representation, IssueRepresentation.Wire);
  }
  try {
    codecs.fromWireFormatTOrder({
      money: { amount: 1, currency: 1 },
      tag: 'refunded',
    }, { failFast: false });
    assert.fail('expected exhaustive validation');
  } catch (error) {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Validation);
    assert.ok(error.issues.length > 1);
  }
  try {
    codecs.fromWireFormatTOrder({
      money: { amount: '12.50', currency: 'USD' },
      extra: true,
    });
    assert.fail('expected exact extra-key rejection');
  } catch (error) {
    assert.ok(error instanceof LibError);
    assert.equal(error.kind, LibErrorKind.Validation);
  }
});
