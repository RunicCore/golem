import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { NestModelInterceptor } from '@exprtlabs/golem/nest';
import { runPipeline } from '#golem/cli';
import { scanProject } from '#golem/rewrite-scan';
import { createContractAnalysis, createProgram, modelBoundary } from '@exprtlabs/golem/type-analysis';
import { applyRewrites } from '#golem/rewrite';
import { createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from '../fixture-project.js';
import { command, golem, workspace } from '../support/process.js';

const sharedModel = (kind: 'IObject' | 'IModel'): string => `import type { ${kind} } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TCustomer = ${kind}<{ name: string & MinLength<3> }>;
`;
const COMPANION = './generated/models/@acme/shared/customer.model.generated.js';

/** An app whose controllers job and models job share `golem.yaml`, next to the shared folder `@acme/shared` that its tsconfig includes. */
function appWithSharedModel(t: TestContext, shared: string, files: Readonly<Record<string, string>>, installed = false): { readonly app: string; readonly config: string } {
  const outer = createFixtureProject(t, 'golem-controllers-shared-');
  // An installed package is a real folder in node_modules, so the workspace's own node_modules is linked package by package.
  if (installed) linkProjectPackages(outer, Object.fromEntries(['@nestjs/common', '@exprtlabs/golem', '@exprtlabs/golem-model', '@exprtlabs/golem-ts-openapi'].map((name) => [name, path.join(workspace, 'node_modules', name)])));
  else fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(outer, 'node_modules'), 'dir');
  const app = path.join(outer, 'app');
  const sources: Record<string, string> = {
    ...(installed ? {
      'node_modules/@acme/shared/package.json': JSON.stringify({ name: '@acme/shared', version: '1.0.0', type: 'module', exports: { './customer.model': { types: './customer.model.d.ts' } } }),
      'node_modules/@acme/shared/customer.model.d.ts': shared,
    } : {
      'shared/package.json': JSON.stringify({ name: '@acme/shared', private: true, type: 'module' }),
      'shared/customer.model.ts': shared,
    }),
    'app/package.json': JSON.stringify({ name: 'app', private: true, type: 'module' }),
    'app/tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, experimentalDecorators: true, emitDecoratorMetadata: true, rootDir: '..', outDir: 'build' },
      include: ['src/**/*.ts', '../shared/**/*.ts'],
    }),
    'app/golem.yaml': [
      'version: 1', 'mobx: false', 'validation: true',
      'controllers:', '  - root: .', '    sources:', '      - src/customers.controller.ts', '    output: generated/api.json', '    info: { title: Test API, version: "1" }',
      'models:', '  root: .', '',
    ].join('\n'),
    ...Object.fromEntries(Object.entries(files).map(([relative, content]) => [`app/${relative}`, content])),
  };
  writeGeneratedArtifacts(Object.entries(sources).map(([relative, content]) => ({ path: path.join(outer, relative), content })));
  return { app: fs.realpathSync(app), config: path.join(fs.realpathSync(app), 'golem.yaml') };
}

const readText = (app: string, relative: string): string => fs.readFileSync(path.join(app, relative), 'utf8');
const readJson = (app: string, relative: string): any => JSON.parse(readText(app, relative));
const codecKey = (app: string, declaration: string): string => readJson(app, '.golem/codec-keys.json').keys[declaration];

const controller = (model: string, from: string, value = false): string => `import { Body, Controller, Post } from '@nestjs/common';
import ${value ? `{ ${model} }` : `type { ${model} }`} from '${from}';

@Controller('customers')
export class CustomersController {
  @Post()
  create(@Body() input: ${model}): ${model} { return input; }
}
`;

/** The controller source as the build rewrites it, found with the codec keys and companions of the app. */
function rewrittenController(app: string): string {
  const scanned = scanProject({ root: app, directory: app, modelsRoot: app, output: path.join(app, 'src/generated/models'), configFile: path.join(app, 'tsconfig.json'), nest: true, codecKeysFile: path.join(app, '.golem/codec-keys.json') });
  assert.deepEqual(scanned.diagnostics, []);
  return applyRewrites(readText(app, 'src/customers.controller.ts'), scanned.files.get('src/customers.controller.ts')!).code;
}

test('a shared IObject alias in a controller signature is a model of the app: its schema is the alias, and the Nest codec id is the id the app generated', async (t) => {
  // protects: A-55 3.8 the shared-alias contract path: schema, codecs and marks of a shared alias use the app's own codec id
  const { app, config } = appWithSharedModel(t, sharedModel('IObject'), { 'src/customers.controller.ts': controller('TCustomer', '../../shared/customer.model.js') });

  await runPipeline(config);

  const id = codecKey(app, '../shared/customer.model.ts#TCustomer');
  assert.match(id, /^TCustomer_[0-9a-f]{8}$/);
  const document = readJson(app, 'generated/api.json');
  assert.deepEqual(document.paths['/customers'].post.requestBody.content['application/json'].schema, { $ref: '#/components/schemas/TCustomer' });
  assert.deepEqual(document.components.schemas.TCustomer, { type: 'object', properties: { name: { allOf: [{ type: 'string' }, { minLength: 3 }] } }, required: ['name'], additionalProperties: false });
  assert.ok(readText(app, 'src/generated/operation-codecs.ts').includes(JSON.stringify(id)), 'the operation codecs of the controllers job hold the id of the app');
  const code = rewrittenController(app);
  assert.ok(code.includes(`@__golem_nestModelCodec(${JSON.stringify(id)}) input: TCustomer`), code);
  assert.ok(code.includes(`@__golem_nestModelReturn(${JSON.stringify(id)})`), code);
  await runPipeline(config, { check: true });
});

test('an alias in the .model.d.ts file of an installed package in a controller signature is a model of the app, with the id the app generated', async (t) => {
  // protects: T-195 an installed package is a shared package for the controllers analysis too (P-12 done check 2)
  const { app, config } = appWithSharedModel(t, sharedModel('IObject'), { 'src/customers.controller.ts': controller('TCustomer', '@acme/shared/customer.model') }, true);

  await runPipeline(config);

  const id = codecKey(app, '../node_modules/@acme/shared/customer.model.d.ts#TCustomer');
  assert.match(id, /^TCustomer_[0-9a-f]{8}$/);
  assert.deepEqual(readJson(app, 'generated/api.json').paths['/customers'].post.requestBody.content['application/json'].schema, { $ref: '#/components/schemas/TCustomer' });
  assert.ok(readText(app, 'src/generated/operation-codecs.ts').includes(JSON.stringify(id)));
  await runPipeline(config, { check: true });
});

/** The SDK package `@acme/sdk`: `money.model.d.ts` holds `TMoney`, which its manifest lists as the SDK model `sdk:money`. */
const SDK_PACKAGE: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: '@acme/sdk', version: '1.0.0', type: 'module', exports: { './money.model': { types: './money.model.d.ts' } } }),
  'money.model.d.ts': "/* @golem-model-manifest ./model-manifest.json */\nimport type { IObject } from '@exprtlabs/golem/model';\nexport type TMoney = IObject<{ currency: string }>;\n",
  'models.ts': 'export class MoneyModel {}\n',
  'model-manifest.json': JSON.stringify({
    profile: { mobx: false, validation: true, allowAny: false },
    models: [{ id: 'sdk:money', codecId: 'Money_0a1b2c3d', allowAny: false, type: { module: './money.model.d.ts', export: 'TMoney' }, generated: { module: './models.ts', export: 'MoneyModel' } }],
  }),
};

for (const place of ['installed', 'linked'] as const) {
  test(`a controller that uses the SDK model of a manifest in an SDK package that is ${place} gets the codec id of the manifest in the codecs and in both Nest marks`, async (t) => {
    // protects: T-195 review: an SDK model keeps its manifest codec id in the controllers analysis (R-20 an SDK keeps working)
    const { app, config } = appWithSharedModel(t, sharedModel('IObject'), { 'src/customers.controller.ts': controller('TMoney', '@acme/sdk/money.model') }, true);
    const outer = path.dirname(app);
    const sdk = place === 'installed' ? path.join(outer, 'node_modules/@acme/sdk') : path.join(outer, 'sdk-src');
    writeGeneratedArtifacts(Object.entries(SDK_PACKAGE).map(([relative, content]) => ({ path: path.join(sdk, relative), content })));
    if (place === 'linked') fs.symlinkSync('../../sdk-src', path.join(outer, 'node_modules/@acme/sdk'), 'dir');

    await runPipeline(config);

    const id = JSON.stringify('Money_0a1b2c3d');
    assert.ok(readText(app, 'src/generated/operation-codecs.ts').includes(id), readText(app, 'src/generated/operation-codecs.ts'));
    assert.doesNotMatch(readText(app, 'src/generated/operation-codecs.ts'), /TMoney_[0-9a-f]{8}/);
    const code = rewrittenController(app);
    assert.ok(code.includes(`@__golem_nestModelCodec(${id}) input: TMoney`), code);
    assert.ok(code.includes(`@__golem_nestModelReturn(${id})`), code);
    const document = readJson(app, 'generated/api.json');
    assert.deepEqual(document.paths['/customers'].post.requestBody.content['application/json'].schema, { $ref: '#/components/schemas/TMoney' });
    assert.deepEqual(document.components.schemas.TMoney, { type: 'object', properties: { currency: { type: 'string' } }, required: ['currency'], additionalProperties: false });
  });
}

test('a model file that the program holds under two names is one model source of the controllers analysis', (t) => {
  // protects: T-195 review: one file under two spellings made collectSpecifications throw RUNM1005
  const outer = createFixtureProject(t, 'golem-controllers-names-');
  fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(outer, 'node_modules'), 'dir');
  writeGeneratedArtifacts([{ path: path.join(outer, 'shared/customer.model.ts'), content: sharedModel('IObject') }]);
  fs.mkdirSync(path.join(outer, 'app'));
  fs.symlinkSync('../shared', path.join(outer, 'app/link'), 'dir');
  const app = path.join(outer, 'app');
  const { program } = createProgram([path.join(app, 'link/customer.model.ts'), path.join(outer, 'shared/customer.model.ts')], app);

  const analysis = createContractAnalysis(program, { root: app, boundary: modelBoundary(app, undefined, { directory: app, output: path.join(app, 'generated') }) });

  assert.deepEqual(analysis.specifications.map(({ name }) => name), ['TCustomer']);
});

// An interface has no model of the app, so the document inlines it; an IObject alias is a model of the controllers analysis, so the document names it.
const SDK_MONEY_KINDS = [
  {
    kind: 'interface',
    declaration: 'export interface TMoney { currency: string }',
    moneyField: { type: 'object', properties: { currency: { type: 'string' } }, required: ['currency'], additionalProperties: false },
    schemaNames: ['TOrder'],
  },
  {
    kind: 'IObject alias',
    declaration: "import type { IObject } from '@exprtlabs/golem/model';\nexport type TMoney = IObject<{ currency: string }>;",
    moneyField: { $ref: '#/components/schemas/TMoney' },
    schemaNames: ['TMoney', 'TOrder'],
  },
] as const;

for (const { kind, declaration, moneyField, schemaNames } of SDK_MONEY_KINDS) {
  test(`an app model that nests an SDK ${kind} has one codec id in the codecs of the controllers job, the codec keys of the models job and both Nest marks`, async (t) => {
    // protects: T-195 P-12 check, T-206: the three places that name a codec id agree for an app model that nests an SDK model, written as an interface or an IObject alias
    const order = "import type { IObject } from '@exprtlabs/golem/model';\nimport type { TMoney } from '@acme/sdk/money.model';\nexport type TOrder = IObject<{ id: string; money: TMoney }>;\n";
    const yaml = ['version: 1', 'mobx: false', 'validation: false', 'controllers:', '  - root: .', '    sources:', '      - src/customers.controller.ts', '    output: generated/api.json', '    info: { title: Test API, version: "1" }', 'models:', '  root: .', ''].join('\n');
    const { app, config } = appWithSharedModel(t, sharedModel('IObject'), { 'src/order.model.ts': order, 'src/customers.controller.ts': controller('TOrder', './order.model.js'), 'golem.yaml': yaml }, true);
    const outer = path.dirname(app);
    // The SDK type is listed by the manifest, so a models job nests it as the generated SDK model.
    const sdk = {
      ...SDK_PACKAGE,
      'model-manifest.json': SDK_PACKAGE['model-manifest.json']!.replace('"validation":true', '"validation":false'),
      'money.model.d.ts': `/* @golem-model-manifest ./model-manifest.json */\n${declaration}\n`,
      'models.ts': 'export class MoneyModel {}\nexport function stringifysdk_money(value: object, _options?: object): string { return JSON.stringify(value); }\nexport function toWireFormatsdk_money(value: unknown, _options?: object): unknown { return value; }\n',
    };
    writeGeneratedArtifacts(Object.entries(sdk).map(([relative, content]) => ({ path: path.join(outer, 'node_modules/@acme/sdk', relative), content })));

    await runPipeline(config);

    const id = codecKey(app, 'src/order.model.ts#TOrder');
    assert.match(id, /^TOrder_[0-9a-f]{8}$/);
    const registry = readText(app, 'src/generated/operation-codecs.ts');
    assert.deepEqual([...new Set(registry.match(/TOrder_[0-9a-f]{8}/g))], [id], registry);
    const code = rewrittenController(app);
    assert.ok(code.includes(`@__golem_nestModelCodec(${JSON.stringify(id)}) input: TOrder`), code);
    assert.ok(code.includes(`@__golem_nestModelReturn(${JSON.stringify(id)})`), code);
    const document = readJson(app, 'generated/api.json');
    assert.deepEqual(document.paths['/customers'].post.requestBody.content['application/json'].schema, { $ref: '#/components/schemas/TOrder' });
    assert.deepEqual(document.components.schemas.TOrder, {
      type: 'object', required: ['id', 'money'], additionalProperties: false,
      properties: { id: { type: 'string' }, money: moneyField },
    });
    assert.deepEqual(Object.keys(document.components.schemas).sort(), schemaNames);
    assert.doesNotMatch(JSON.stringify(document), /__exprtGeneratedModel/);
  });
}

test('a controller that returns an app class extending the generated base of a shared IModel is matched to the model: the document and the return mark use it', async (t) => {
  // protects: T-195 the controllers analysis finds a shared companion in models.output, as the models job writes it
  const { app, config } = appWithSharedModel(t, sharedModel('IModel'), {
    'src/customer.ts': `import { TCustomerBaseModel } from '${COMPANION}';\nexport class Customer extends TCustomerBaseModel {}\n`,
    'src/customers.controller.ts': controller('Customer', './customer.js', true),
  });

  await runPipeline(config);

  const id = codecKey(app, '../shared/customer.model.ts#TCustomer');
  const document = readJson(app, 'generated/api.json');
  assert.deepEqual(Object.keys(document.components.schemas), ['TCustomer'], 'the app class names no component: a shared model keeps its alias');
  assert.deepEqual(document.paths['/customers'].post.responses['201'].content['application/json'].schema, { $ref: '#/components/schemas/TCustomer' });
  assert.ok(readText(app, 'src/generated/operation-codecs.ts').includes(JSON.stringify(id)));
  assert.ok(rewrittenController(app).includes(`@__golem_nestModelReturn(${JSON.stringify(id)})`));
  await runPipeline(config, { check: true });
});

test('at run time the @Body() of a shared alias is parsed with the codec of the app, and the codec module loads with no import in the controller', async (t) => {
  // protects: A-55 3.8 the run-time path: a built controller of a shared alias loads the app codec by itself and validates a @Body()
  const { app } = appWithSharedModel(t, sharedModel('IObject'), { 'src/customers.controller.ts': controller('TCustomer', '../../shared/customer.model.js') });

  const built = await command(app, process.execPath, [golem, 'build', '--config', path.join(app, 'golem.yaml')]);

  assert.equal(built.code, 0, built.stderr);
  assert.ok(!readText(app, 'src/customers.controller.ts').includes('generated'), 'the controller source imports no codec module');
  const { CustomersController } = await import(pathToFileURL(path.join(app, 'build/app/src/customers.controller.js')).href) as { CustomersController: new () => object };
  class AppModule {}
  Module({ controllers: [CustomersController] })(AppModule);
  const application = await NestFactory.create(AppModule, { logger: false });
  application.useGlobalInterceptors(new NestModelInterceptor());
  await application.listen(0, '127.0.0.1');
  try {
    const url = `${await application.getUrl()}/customers`;
    const post = (body: unknown): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ name: 'Ann' })).status, 201);
    assert.equal((await post({ name: 'Al' })).status, 400, 'the minLength tag of the shared alias rejects it');
  } finally {
    await application.close();
  }
});

test('a shared alias with a TSerde field has one codec id in the codecs of the controllers job, the codec keys of the models job and both Nest marks', async (t) => {
  // protects: T-197 final review: the TSerde importer is the companion of the model in both jobs, so the hashed function id is the same
  const model = "import type { IObject } from '@exprtlabs/golem/model';\nimport type { TSerde } from '@exprtlabs/golem/tags';\nimport type { encodeCount, decodeCount } from './rules.js';\nexport type TCustomer = IObject<{ visits: number & TSerde<typeof encodeCount, typeof decodeCount> }>;\n";
  const { app, config } = appWithSharedModel(t, model, { 'src/customers.controller.ts': controller('TCustomer', '@acme/shared/customer.model') }, true);
  const outer = path.dirname(app);
  // The shared package is a linked workspace package with an exports map, as a monorepo keeps it.
  fs.rmSync(path.join(outer, 'node_modules/@acme/shared'), { recursive: true });
  writeGeneratedArtifacts([
    { path: path.join(outer, 'shared/package.json'), content: JSON.stringify({ name: '@acme/shared', private: true, type: 'module', exports: { './customer.model': { types: './customer.model.ts' }, './rules': { types: './rules.ts', default: './rules.js' } } }) },
    { path: path.join(outer, 'shared/customer.model.ts'), content: model },
    { path: path.join(outer, 'shared/rules.ts'), content: 'export function encodeCount(value: number): string { return String(value); }\nexport function decodeCount(value: string): number { return Number(value); }\n' },
  ]);
  fs.symlinkSync('../../shared', path.join(outer, 'node_modules/@acme/shared'), 'dir');

  await runPipeline(config);

  const id = codecKey(app, '../shared/customer.model.ts#TCustomer');
  assert.match(id, /^TCustomer_[0-9a-f]{8}$/);
  const registry = readText(app, 'src/generated/operation-codecs.ts');
  assert.deepEqual([...new Set(registry.match(/TCustomer_[0-9a-f]{8}/g))], [id], registry);
  const code = rewrittenController(app);
  assert.ok(code.includes(`@__golem_nestModelCodec(${JSON.stringify(id)}) input: TCustomer`), code);
  assert.ok(code.includes(`@__golem_nestModelReturn(${JSON.stringify(id)})`), code);
});
