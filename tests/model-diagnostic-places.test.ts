import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { generate } from '#model/generator';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { readFixture } from './fixture-project.js';
import { createModelProject } from './model-project.js';
import { watchPipeline } from '#golem/cli';
import { command, golem } from './support/process.js';
import { until } from './support/watch-wait.js';

// protects: T-313 RUNM1053 points at the inline IObject variant and prints its text
for (const [name, variants, place] of [
  ['the first inline variant', 'IObject<{ text: string }> | IObject<{ body: string }>', ':3:24 '],
  ['an inline variant after a named one', 'TText | IObject<{ body: string }>', ':3:32 '],
] as const) {
  test(`RUNM1053 points at ${name} of a union and prints its text`, (t: TestContext) => {
    const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-nested-variants-', name: 'nested-variants' });
    fs.writeFileSync(path.join(sourceRoot, 'comment.model.ts'), [
      "import type { IModel, IObject } from '@exprtlabs/golem/model';",
      '',
      `export type TComment = ${variants};`,
      'export type TText = IObject<{ text: string }>;',
      'export type TThread = IModel<{ comments: TComment[] }>;',
      '',
    ].join('\n'));
    assert.throws(
      () => generate({ root, profile: { validation: true } }),
      new RegExp(`comment\\.model\\.ts${place}RUNM1053: .*IObject<\\{ (text|body): string \\}>`),
    );
  });
}

/** A project with a docs job and a model `tags: strin[]` that names a type that does not exist. */
function brokenModelProject(t: TestContext): string {
  return createControllerFixture(t, {
    prefix: 'golem-unresolved-contract-',
    packageName: 'unresolved-contract',
    links: 'workspace',
    files: {
      'golem.yaml': 'version: 1\nts-openapi:\n  docs:\n    - output: ./generated/openapi.json\n      info:\n        title: Catalog API\n        version: "1"\nmodel: {}\n',
      'src/catalog.controller.ts': readFixture('controllers/watch/project/controller.ts').replace("import { routeFor } from './route-helper.js';\n", '').replace("routeFor('list')", "'list'"),
      'src/item.model.ts': [
        "import type { IModel } from '@exprtlabs/golem/model';",
        '',
        'export type TItem = IModel<{',
        '  id: string;',
        '  tags: strin[];',
        '}>;',
        '',
      ].join('\n'),
    },
  });
}

// protects: T-313 RUNM1058 from the controllers job names the TypeScript error at its position
test('RUNM1058 from the controllers job names the first TypeScript error at the unresolved type', async (t: TestContext) => {
  const root = brokenModelProject(t);
  const result = await command(root, process.execPath, [golem, 'generate'], { allowFailure: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /item\.model\.ts:5:9 RUNM1058: .*TS\d+.*strin/);
});

// protects: T-313 a broken model gives the same TypeScript cause at watch start and after an edit
test('golem watch names the TypeScript error of an unresolved model type at its start and after an edit', async (t: TestContext) => {
  const root = brokenModelProject(t);
  const model = path.join(root, 'src/item.model.ts');
  const broken = fs.readFileSync(model, 'utf8');
  fs.writeFileSync(model, broken.replace('strin[]', 'string[]'));
  const errors: string[] = [];
  const stop = watchPipeline(path.join(root, 'golem.yaml'), error => { errors.push(String(error)); });
  try {
    await until(() => fs.existsSync(path.join(root, 'src/item.model.generated.ts')), 'the first generation writes the model companion');
    fs.writeFileSync(model, broken);
    await until(() => errors.length > 0, () => 'the edit is reported');
    assert.match(errors.join('\n'), /item\.model\.ts:5:9 .*TS\d+.*strin/);
  } finally {
    stop();
  }
});
