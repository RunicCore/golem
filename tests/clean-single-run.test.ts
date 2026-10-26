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

const plainController = [
  "import { Controller, Get } from '@nestjs/common';",
  'interface Status { ok: boolean }',
  "@Controller('catalog')",
  'export class CatalogController {',
  '  @Get()',
  '  list(): Status { return { ok: true }; }',
  '}',
  '',
].join('\n');

const reachingController = [
  "import { Controller, Get } from '@nestjs/common';",
  "import type { TCart } from './cart.model.js';",
  "@Controller('catalog')",
  'export class CatalogController {',
  '  @Get()',
  "  cart(): TCart { return { money: { amount: 1, currency: 'EUR' }, note: '' }; }",
  '}',
  '',
].join('\n');

/** A clean tree: no SDK, no generated file and no `.golem/`. The model under the controllers root imports the SDK the openapi job of the same golem.yaml writes. */
function cleanProject(t: TestContext, controller: string): string {
  const root = createControllerFixture(t, {
    prefix: 'golem-clean-run-',
    packageName: 'clean-run',
    links: 'workspace',
    tsconfig: JSON.parse(readFixture('packed/profile/tsconfig.json')) as Record<string, unknown>,
    files: { 'golem.yaml': config, 'src/catalog.controller.ts': controller },
  });
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');
  copyFixtureFile(root, 'packed/profile/src/cart.model.ts', 'src/cart.model.ts');
  return root;
}

// protects: T-464 one run from a clean tree passes when a model the controllers do not reach imports the SDK
test('a clean tree generates in one run when an unreached model under the controllers root imports the SDK', async (t: TestContext) => {
  const root = cleanProject(t, plainController);
  assert.equal(fs.existsSync(path.join(root, 'sdk')), false);

  await runPipeline(path.join(root, 'golem.yaml'));

  for (const written of ['generated/openapi.json', 'sdk/index.ts', 'src/cart.model.generated.ts']) {
    assert.equal(fs.existsSync(path.join(root, written)), true, `${written} is written`);
  }
  await runPipeline(path.join(root, 'golem.yaml'), { check: true });
});

// protects: T-464 a controller that reaches a model of a later job's output gets the cycle error, not RUNM1058
test('a controller that reaches a model importing the SDK gets the job-order cycle error', async (t: TestContext) => {
  const root = cleanProject(t, reachingController);

  await assert.rejects(runPipeline(path.join(root, 'golem.yaml')), (error: unknown) => {
    assert.match(String(error), /Generated input dependency cycle: .*cart\.model\.ts.*sdk\/index\.js/);
    assert.doesNotMatch(String(error), /RUNM1058/);
    return true;
  });
});
