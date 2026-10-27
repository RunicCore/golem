// lane: typescript6 Checker guards: the controllers job reads the checker's declarations and unresolved imports in this process
import { copyFixtureFile, fileFixtureScope, onceShared, readFixture } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPipeline } from '#golem/cli';
import { operationCodecRegistryPath } from '#golem/generated-paths';

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

const model = (name: string, fields: string, imports = ''): string => [
  "import type { IModel } from '@exprtlabs/golem/model';",
  imports,
  `export type ${name} = IModel<{ ${fields} }>;`,
  '',
].join('\n');

/** The models of the project: `src/cart.model.ts` imports the SDK (the packed fixture), the order model holds it, the two charges share a name. */
const models: Record<string, string> = {
  'src/status.model.ts': model('TStatus', 'ok: boolean'),
  'src/order.model.ts': model('TOrder', 'cart: TCart', "import type { TCart } from './cart.model.js';"),
  'src/a/charge.model.ts': model('TCharge', 'money: Money', "import type { Money } from '../../sdk/index.js';"),
  'src/b/charge.model.ts': model('TCharge', 'amount: number'),
  'src/inline.model.ts': model('TInline', "money: import('../sdk/index.js').Money"),
  'src/aliased.model.ts': model('TAliased', 'cart: TCart', "import type { TCart } from '@app/cart.model.js';"),
};

const controller = (returns: string, imports = '', body = 'undefined as never'): string => [
  "import { Controller, Get } from '@nestjs/common';",
  "import type { TCart } from './cart.model.js';",
  "import type { TStatus } from './status.model.js';",
  "import type { TCharge } from './b/charge.model.js';",
  imports,
  "@Controller('catalog')",
  'export class CatalogController {',
  '  @Get()',
  `  list()${returns && `: ${returns}`} { return ${body}; }`,
  '}',
  '',
].join('\n');

const keeps = controller('TStatus | TCharge');

/** The packed profile's tsconfig, with an `@app/*` alias of `src/*`. */
function tsconfig(): Record<string, unknown> {
  const profile = JSON.parse(readFixture('packed/profile/tsconfig.json')) as { compilerOptions: Record<string, unknown> };
  return { ...profile, compilerOptions: { ...profile.compilerOptions, paths: { '@app/*': ['./src/*'] } } };
}

/** A clean tree: no SDK, no generated file and no `.golem/`. Models under the controllers root import the SDK that the openapi job of the same golem.yaml writes. */
function cleanProject(t: TestContext, source: string, yaml = config, files: Record<string, string> = models): string {
  const root = createControllerFixture(t, {
    prefix: 'golem-clean-run-',
    packageName: 'clean-run',
    links: 'workspace',
    tsconfig: tsconfig(),
    files: { 'golem.yaml': yaml, 'src/catalog.controller.ts': source, ...files },
  });
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');
  if (!('src/cart.model.ts' in files)) copyFixtureFile(root, 'packed/profile/src/cart.model.ts', 'src/cart.model.ts');
  return root;
}

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const sdkUnknownFormats = (root: string): string => (JSON.parse(read(root, 'sdk/model-manifest.json')) as { profile: { unknownFormats: string } }).profile.unknownFormats;

// protects: T-464 a clean run and a run with the SDK present give the same document and registry
test('a clean tree generates in one run, and the run after it writes the same document and registry', async (t: TestContext) => {
  const root = cleanProject(t, keeps);
  const yaml = path.join(root, 'golem.yaml');
  assert.equal(fs.existsSync(path.join(root, 'sdk')), false);

  await runPipeline(yaml);
  for (const written of ['generated/openapi.json', 'sdk/index.ts', 'src/cart.model.generated.ts', 'src/status.model.generated.ts']) {
    assert.equal(fs.existsSync(path.join(root, written)), true, `${written} is written`);
  }
  const registry = path.relative(root, operationCodecRegistryPath(root));
  const first = { document: read(root, 'generated/openapi.json'), registry: read(root, registry) };
  // The inline `import('../sdk/index.js').Money` model and the model that reaches the SDK through a `paths` alias are left out too.
  assert.deepEqual(Object.keys((JSON.parse(first.document) as { components: { schemas: object } }).components.schemas), ['TCharge', 'TStatus']);

  // A changed controller file makes the controllers job read the project again, now with the SDK on disk.
  fs.appendFileSync(path.join(root, 'src/catalog.controller.ts'), '// second run\n');
  await runPipeline(yaml);
  assert.deepEqual({ document: read(root, 'generated/openapi.json'), registry: read(root, registry) }, first);
  await runPipeline(yaml, { check: true });
});

// protects: T-517 a profile option change failed on the SDK manifest of the run before, which the openapi job was about to rewrite
test('a profile option changed after a run regenerates the SDK manifest with the new profile in one run', async (t: TestContext) => {
  const root = cleanProject(t, keeps);
  const yaml = path.join(root, 'golem.yaml');
  await runPipeline(yaml);
  assert.equal(sdkUnknownFormats(root), 'error');

  fs.writeFileSync(yaml, config.replace('validation: true\n', 'validation: true\nunknownFormats: warn\n'));
  await runPipeline(yaml);

  assert.equal(sdkUnknownFormats(root), 'warn');
  await runPipeline(yaml, { check: true });
});

const reaches = [
  ['returns it', 'TCart', '', undefined],
  ['returns an array of it', 'TCart[]', '', undefined],
  ['picks a field of it that holds no SDK type', "Pick<TCart, 'note'>", '', undefined],
  ['returns it in a union', 'TStatus | TCart', '', undefined],
  ['returns a model that holds it', 'TStatus | TOrder', "import type { TOrder } from './order.model.js';", undefined],
  ['returns an inferred Map of it', '', '', 'new Map<string, TCart>()'],
  ['imports an SDK type', 'Money', "import type { Money } from '../sdk/index.js';", undefined],
  ['returns a local type that holds an SDK type', 'Local', "import type { Money } from '../sdk/index.js';\ntype Local = { m: Money };", undefined],
] as const;
const cycle = (error: unknown): boolean => /RUNM1084: Generated input dependency cycle: the controllers job reads .*, which is, or imports, a file that a later job writes/.test(String(error)) && !/RUNM1058/.test(String(error));

// One project whose SDK is on disk, shared by the cases: the controller file changes, the models stay.
const fileScope = fileFixtureScope();
const withSdk = onceShared(async () => {
  const root = createControllerFixture(fileScope, {
    prefix: 'golem-clean-run-sdk-', packageName: 'clean-run-sdk', links: 'workspace', tsconfig: tsconfig(),
    files: { 'golem.yaml': config, 'src/catalog.controller.ts': keeps, ...models },
  });
  copyFixtureFile(root, 'packed/profile/api.json', 'api.json');
  copyFixtureFile(root, 'packed/profile/src/cart.model.ts', 'src/cart.model.ts');
  await runPipeline(path.join(root, 'golem.yaml'));
  return root;
});

// protects: T-464 a controller that reaches a model with an SDK import gets RUNM1084 in every run
for (const [reach, returns, imports, body] of reaches) {
  test(`a controller that ${reach} stops with RUNM1084 on a clean tree`, async (t: TestContext) => {
    const root = cleanProject(t, controller(returns, imports, body));

    await assert.rejects(runPipeline(path.join(root, 'golem.yaml')), cycle);
  });
  test(`a controller that ${reach} stops with RUNM1084 when the SDK is present`, async () => {
    const root = await withSdk();
    fs.writeFileSync(path.join(root, 'src/catalog.controller.ts'), controller(returns, imports, body));

    await assert.rejects(runPipeline(path.join(root, 'golem.yaml')), cycle);
  });
}

// protects: T-464 an import that no later job writes keeps RUNM1058 in a model that no controller reaches
test('a typo in the import of an unreached model still stops with RUNM1058 when no job writes that path', async (t: TestContext) => {
  const withoutModels = config.replace('models:\n  root: .\n', '');
  const typo = model('TCart', 'money: Money', "import type { Money } from '../skd/index.js';");
  const root = cleanProject(t, keeps, withoutModels, { ...models, 'src/cart.model.ts': typo });

  await assert.rejects(runPipeline(path.join(root, 'golem.yaml')), /cart\.model\.ts:3:\d+ RUNM1058/);
});
