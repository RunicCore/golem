// lane: typescript6 Checker guards: the controllers job reads the checker's unresolved-import diagnostics and types in this process
import { copyFixtureFile, readFixture } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';

const config = [
  'version: 1',
  'mobx: false',
  'validation: true',
  'controllers:',
  '  - root: .',
  '    output: generated/openapi.json',
  '    info: { title: Catalog API, version: "1" }',
  'openapi:',
  '  - input: api.json',
  '    output: sdk',
  '    name: Profile',
  'models:',
  '  root: .',
  '',
].join('\n');

const statusModel = [
  "import type { IModel } from '@exprtlabs/golem/model';",
  'export type TStatus = IModel<{ ok: boolean }>;',
  '',
].join('\n');

// A second model that holds the SDK model: it is left out with it.
const orderModel = [
  "import type { IModel } from '@exprtlabs/golem/model';",
  "import type { TCart } from './cart.model.js';",
  'export type TOrder = IModel<{ cart: TCart }>;',
  '',
].join('\n');

const controllerReturning = (type: string, value: string): string => [
  "import { Controller, Get } from '@nestjs/common';",
  "import type { TCart } from './cart.model.js';",
  "import type { TStatus } from './status.model.js';",
  "@Controller('catalog')",
  'export class CatalogController {',
  '  @Get()',
  `  list(): ${type} { return ${value}; }`,
  '}',
  '',
].join('\n');

/** A clean tree: no SDK, no generated file and no `.golem/`. The model under the controllers root imports the SDK the openapi job of the same golem.yaml writes. */
function cleanProject(t: TestContext, controller: string, yaml = config, cart?: string): string {
  const root = createControllerFixture(t, {
    prefix: 'golem-clean-run-',
    packageName: 'clean-run',
    links: 'workspace',
    tsconfig: JSON.parse(readFixture('packed/profile/tsconfig.json')) as Record<string, unknown>,
    files: { 'golem.yaml': yaml, 'src/catalog.controller.ts': controller, 'src/status.model.ts': statusModel, 'src/order.model.ts': orderModel },
  });
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');
  if (cart === undefined) copyFixtureFile(root, 'packed/profile/src/cart.model.ts', 'src/cart.model.ts');
  else fs.writeFileSync(path.join(root, 'src/cart.model.ts'), cart);
  return root;
}

// protects: T-464 one run from a clean tree passes when a model the controllers do not reach imports the SDK
test('a clean tree generates in one run when an unreached model under the controllers root imports the SDK', async (t: TestContext) => {
  const root = cleanProject(t, controllerReturning('TStatus', '{ ok: true }'));
  assert.equal(fs.existsSync(path.join(root, 'sdk')), false);

  await runPipeline(path.join(root, 'golem.yaml'));

  for (const written of ['generated/openapi.json', 'sdk/index.ts', 'src/cart.model.generated.ts', 'src/order.model.generated.ts']) {
    assert.equal(fs.existsSync(path.join(root, written)), true, `${written} is written`);
  }
  await runPipeline(path.join(root, 'golem.yaml'), { check: true });
  const document = JSON.parse(fs.readFileSync(path.join(root, 'generated/openapi.json'), 'utf8')) as { components: { schemas: Record<string, unknown> } };
  assert.deepEqual(Object.keys(document.components.schemas), ['TStatus']);
});

// protects: T-464 a controller that reaches a model of a later job's output gets the cycle error, not RUNM1058
for (const [reach, type, value] of [['returns', 'TCart', "{ money: { amount: 1, currency: 'EUR' }, note: '' }"], ['returns an array of', 'TCart[]', '[]']] as const) {
  test(`a controller that ${reach} a model importing the SDK gets the job-order cycle error`, async (t: TestContext) => {
    const root = cleanProject(t, controllerReturning(type, value));

    await assert.rejects(runPipeline(path.join(root, 'golem.yaml')), (error: unknown) => {
      assert.match(String(error), /RUNM1084: Generated input dependency cycle: .*cart\.model\.ts.*sdk\/index\.js/);
      assert.doesNotMatch(String(error), /RUNM1058/);
      return true;
    });
  });
}

// protects: T-464 an import that no later job writes keeps RUNM1058 in a model that no controller reaches
test('a typo in the import of an unreached model still stops with RUNM1058 when no job writes that path', async (t: TestContext) => {
  const withoutModels = config.replace('models:\n  root: .\n', '');
  const typo = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Money } from '../skd/index.js';\nexport type TCart = IModel<{ money: Money }>;\n";
  const root = cleanProject(t, controllerReturning('TStatus', '{ ok: true }'), withoutModels, typo);

  await assert.rejects(runPipeline(path.join(root, 'golem.yaml')), /cart\.model\.ts:3:\d+ RUNM1058/);
});
