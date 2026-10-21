import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from './fixture-project.js';
import { writeModelSources } from './model-project.js';
import { command, golem } from './support/process.js';
import { literal, tsSource, type SourceFragment } from './source-template.js';
import { createJobAnalysis } from '#model/emit';
import { generate } from '#model/generator';
import { applyRewrites } from '#golem/rewrite';
import { scanProject } from '#golem/rewrite-scan';
import { collectSpecifications, companionFilename, createProgram, isOwnModelFile, loadModelManifests, modelBoundary, modelSpecificationForClass } from '@exprtlabs/golem/type-analysis';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const PROFILE = { mobx: false, validation: false };
const CUSTOMER = tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TCustomer = IModel<{ name: string & MinLength<3> }>;
`;
const ORDER = (from: string): SourceFragment => tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TCustomer } from ${literal(from)};
export type TOrder = IModel<{ customer: TCustomer }>;
`;

const PLAIN_ORDER = tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TOrder = IModel<{ id: string }>;
`;

/** `outer/app` (tsconfig includes `../shared`) next to `outer/shared`, which holds `customer.model.ts`. */
function appBesideShared(t: TestContext, order: string | undefined, shared: Readonly<Record<string, string | SourceFragment>> = {}): { readonly outer: string; readonly root: string } {
  const outer = createFixtureProject(t, 'golem-shared-files-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  const root = path.join(outer, 'app');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true },
    include: ['src/**/*.ts', '../shared/**/*.ts'],
  }));
  writeModelSources(path.join(root, 'src'), { 'order.model.ts': order === undefined ? PLAIN_ORDER : ORDER(order) });
  writeModelSources(path.join(outer, 'shared'), { 'package.json': JSON.stringify({ name: '@acme/shared', private: true, type: 'module' }), 'customer.model.ts': CUSTOMER, ...shared });
  return { outer, root: fs.realpathSync(root) };
}

/** Installs `@acme/shared` in `outer/node_modules` with a `.model.d.ts` file whose alias has a tag, and a TSerde tag. */
function installSharedDeclarations(outer: string): string {
  const packageRoot = path.join(outer, 'node_modules/@acme/shared');
  writeModelSources(packageRoot, {
    'package.json': JSON.stringify({ name: '@acme/shared', version: '1.0.0', type: 'module', exports: { './customer.model': { types: './customer.model.d.ts' }, './codecs': { types: './codecs.d.ts', import: './codecs.js' } } }),
    'codecs.d.ts': 'export declare function encodeCount(value: number): string;\nexport declare function decodeCount(value: string): number;\n',
    'codecs.js': 'export function encodeCount(value) { return String(value); }\nexport function decodeCount(value) { return Number(value); }\n',
    'customer.model.d.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength, TSerde } from '@exprtlabs/golem/tags';
import type { encodeCount, decodeCount } from './codecs.js';
export type TCustomer = IModel<{ name: string & MinLength<3>; visits: number & TSerde<typeof encodeCount, typeof decodeCount> }>;
`,
  });
  return fs.realpathSync(path.join(packageRoot, 'customer.model.d.ts'));
}

test('type analysis reads the tags of an alias in the .model.d.ts file of an installed package, and the app model nests it as a model', (t: TestContext) => {
  // protects: R-20 an installed package declares models
  const { outer, root } = appBesideShared(t, '@acme/shared/customer.model');
  fs.rmSync(path.join(outer, 'shared'), { recursive: true });
  const declaration = installSharedDeclarations(outer);
  const order = path.join(root, 'src/order.model.ts');
  const info = createProgram([order], root);
  const { checker, specifications } = collectSpecifications(info.program, [order, declaration]);
  const job = createJobAnalysis(checker, specifications, loadModelManifests(root, info, [], PROFILE), PROFILE, [order], root, info.options);
  const describe = (name: string): { properties: Record<string, object> } => {
    const specification = specifications.find((item) => item.name === name);
    assert.ok(specification);
    return job.describe(specification.fieldsType, specification, undefined, specification.fieldsNode) as unknown as { properties: Record<string, object> };
  };

  const customer = describe('TCustomer').properties;
  assert.deepEqual((customer.name as { constraints: object[] }).constraints, [{ kind: 'minLength', value: 3 }]);
  assert.equal((customer.visits as { serde: { serialize: { exportName: string } } }).serde.serialize.exportName, 'encodeCount');
  assert.deepEqual(describe('TOrder').properties.customer, { kind: 'reference', name: 'TCustomer' });
});

test('a model file is own only inside the models root: a folder, a folder link, a linked package and node_modules hold shared files', (t: TestContext) => {
  // protects: R-20 three kinds of model file
  const { outer, root } = appBesideShared(t, '../../shared/customer.model.js');
  fs.symlinkSync('../../shared', path.join(root, 'src/linked'), 'dir');
  fs.mkdirSync(path.join(root, 'node_modules/@acme/own'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/@acme/own/own.model.ts'), '');
  fs.writeFileSync(path.join(root, 'src/types.model.d.ts'), '');
  const boundary = modelBoundary(root);
  const kinds = [
    path.join(root, 'src/order.model.ts'),
    path.join(outer, 'shared/customer.model.ts'),
    path.join(root, 'src/linked/customer.model.ts'),
    installSharedDeclarations(outer),
    path.join(root, 'node_modules/@acme/own/own.model.ts'),
    path.join(root, 'src/types.model.d.ts'),
  ].map((file) => isOwnModelFile(boundary, file));
  assert.deepEqual(kinds, [true, false, false, false, false, false]);
});

test('a golem.yaml in a shared folder gives one warning that names it, and generation goes on without it', (t: TestContext) => {
  // protects: D-34 warn about a golem.yaml in a shared package, no hard reject
  const { outer, root } = appBesideShared(t, undefined, {
    'golem.yaml': 'version: 1\n',
    'address.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TAddress = IObject<{ street: string }>;
`,
  });
  const yaml = path.join(fs.realpathSync(path.join(outer, 'shared')), 'golem.yaml');

  const result = generate({ root, profile: PROFILE });

  assert.deepEqual(result.diagnostics?.map(({ code, severity, file }) => ({ code, severity, file })), [{ code: 'RUNM1076', severity: 'warning', file: yaml }]);
  assert.match(result.diagnostics?.[0].message ?? '', new RegExp(`^${yaml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is a golem.yaml in the shared folder of the model file .*Golem does not read it. A shared package holds no golem.yaml. Delete it.$`));
  assert.ok(result.artifacts.some((artifact) => artifact.path === path.join(root, 'src/order.model.generated.ts')));
});

test('a golem.yaml of another app beside a shared model file gives a warning that says to move the model', (t: TestContext) => {
  // protects: D-34 another app's golem.yaml warning names the way out
  const { outer, root } = appBesideShared(t, undefined, { 'golem.yaml': 'version: 1\nmodels:\n  root: .\n' });

  const { diagnostics } = generate({ root, profile: PROFILE });

  assert.equal(diagnostics?.length, 1);
  assert.match(diagnostics?.[0].message ?? '', /It configures another app that generates customer\.model\.ts\. Move the model into a shared package that holds no golem\.yaml, and have each app use it from there\.$/);
  assert.equal(diagnostics?.[0].file, path.join(fs.realpathSync(path.join(outer, 'shared')), 'golem.yaml'));
});

test('a generated file beside a shared model file gives one warning each, and generation goes on without them', (t: TestContext) => {
  // protects: D-34 warn about a companion beside a shared model file
  const { outer, root } = appBesideShared(t, undefined, {
    'customer.model.generated.ts': 'export {};\n',
    'customer.model.generated.js': 'export {};\n',
    'customer.model.generated.d.ts': 'export {};\n',
  });
  const shared = fs.realpathSync(path.join(outer, 'shared'));

  const result = generate({ root, profile: PROFILE });

  assert.deepEqual(result.diagnostics?.map(({ code, file }) => ({ code, file })), ['d.ts', 'js', 'ts'].map((form) => ({ code: 'RUNM1076', file: path.join(shared, `customer.model.generated.${form}`) })));
  assert.ok(result.artifacts.some((artifact) => artifact.path === path.join(root, 'src/order.model.generated.ts')));
});

/** `outer/shared` (package `@acme/shared`, `customer.model.ts`) and an app `outer/<name>` that includes the shared folder, with the given source files. */
function appWithShared(outer: string, name: string, validation: boolean, files: Readonly<Record<string, string>>, include = ['src/**/*.ts', '../shared/**/*.ts']): string {
  const root = path.join(outer, name);
  writeModelSources(root, {
    'package.json': JSON.stringify({ name, private: true, type: 'module' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true }, include }),
    ...files,
  });
  return fs.realpathSync(root);
}

const SHARED_CUSTOMER_BASE = "import { TCustomerBaseModel } from './generated/models/@acme/shared/customer.model.generated.js';\nexport class Customer extends TCustomerBaseModel {}\n";
const SHARED_ORDER = (from: string): string => `import type { IModel } from '@exprtlabs/golem/model';\nimport type { TCustomer } from '${from}';\nexport type TOrder = IModel<{ customer: TCustomer }>;\n`;

function sharedFolder(t: TestContext): string {
  const outer = createFixtureProject(t, 'golem-shared-apps-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  writeModelSources(path.join(outer, 'shared'), { 'package.json': JSON.stringify({ name: '@acme/shared', private: true, type: 'module' }), 'customer.model.ts': CUSTOMER });
  return outer;
}

test('two apps with different profiles each write the companion of a shared alias in their own models.output, and the shared folder keeps only its author files', (t: TestContext) => {
  // protects: P-12 done checks 1 and 3: a shared alias works in two apps, each app owns its companion
  const outer = sharedFolder(t);
  const web = appWithShared(outer, 'web', true, { 'src/order.model.ts': SHARED_ORDER('../../shared/customer.model.js'), 'src/customer.ts': SHARED_CUSTOMER_BASE });
  const worker = appWithShared(outer, 'worker', false, { 'src/order.model.ts': SHARED_ORDER('../../shared/customer.model.js'), 'src/customer.ts': SHARED_CUSTOMER_BASE });

  for (const [root, validation] of [[web, true], [worker, false]] as const) {
    writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation } }).artifacts);
  }

  assert.deepEqual(fs.readdirSync(path.join(outer, 'shared')).sort(), ['customer.model.ts', 'package.json']);
  const companion = (root: string): string => fs.readFileSync(path.join(root, 'src/generated/models/@acme/shared/customer.model.generated.ts'), 'utf8');
  assert.match(companion(web), /export abstract class TCustomerBaseModel/);
  assert.match(companion(web), /models\.validators\.generated/);
  assert.match(companion(worker), /export abstract class TCustomerBaseModel/);
  assert.doesNotMatch(companion(worker), /models\.validators\.generated/);
});

test('a field typed with an app class of a shared model generates, imports the shared companion and compiles', async (t: TestContext) => {
  // protects: T-205 a field typed with a class of a shared model generates
  const outer = sharedFolder(t);
  linkProjectPackages(outer, { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') });
  const order = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Customer } from './customer.js';\nexport type TOrder = IModel<{ customer: Customer }>;\n";
  const app = appWithShared(outer, 'web', false, { 'src/order.model.ts': order, 'src/customer.ts': SHARED_CUSTOMER_BASE, 'golem.yaml': 'version: 1\nmodels:\n  root: .\n' });

  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, outDir: 'build', rootDir: '..' }, include: ['src/**/*.ts', '../shared/**/*.ts'] }));

  await command(app, process.execPath, [golem, 'build']);

  const companion = fs.readFileSync(path.join(app, 'src/order.model.generated.ts'), 'utf8');
  assert.match(companion, /import \{ TCustomerBaseModel, .* \} from "\.\/generated\/models\/@acme\/shared\/customer\.model\.generated\.js";/);
});

test('on the first run an app class that imports the shared base through a paths alias is the class of the shared model', (t: TestContext) => {
  // protects: T-197 final review: module resolution of an expected companion works for any import form, not only a relative one
  const outer = sharedFolder(t);
  const app = appWithShared(outer, 'web', false, {
    'src/order.model.ts': SHARED_ORDER('../../shared/customer.model.js'),
    'src/customer.ts': SHARED_CUSTOMER_BASE.replace('./generated/models/', '#models/'),
  });
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true, paths: { '#models/*': ['./src/generated/models/*'] } }, include: ['src/**/*.ts', '../shared/**/*.ts'] }));
  const boundary = modelBoundary(app, undefined, { directory: app, output: path.join(app, 'src/generated/models') });
  const customer = path.join(app, 'src/customer.ts');
  const info = createProgram([path.join(app, 'src/order.model.ts'), customer], app);
  const { checker, specifications } = collectSpecifications(info.program, [path.join(outer, 'shared/customer.model.ts')], undefined, (file) => companionFilename(boundary, file));

  const classSymbol = checker.getExportsOfModule(checker.getSymbolAtLocation(info.program.getSourceFile(customer)!)!).find((symbol) => symbol.name === 'Customer')!;
  const specification = modelSpecificationForClass(checker, checker.getDeclaredTypeOfSymbol(classSymbol), specifications, info.options);

  assert.equal(specification?.name, 'TCustomer');
});

test('an app with no model file of its own generates the companion of the shared alias its program holds', (t: TestContext) => {
  // protects: P-12 done check 1: an app that uses only shared aliases gets its companions
  const outer = sharedFolder(t);
  const app = appWithShared(outer, 'solo', false, { 'src/use.ts': "import type { TCustomer } from '../../shared/customer.model.js';\nexport type Used = TCustomer;\n" });

  const { artifacts } = generate({ root: app, profile: PROFILE });

  assert.ok(artifacts.some((artifact) => artifact.path === path.join(app, 'src/generated/models/@acme/shared/customer.model.generated.ts')));
});

test('two shared model files with one companion path stop generation with an error that names both', (t: TestContext) => {
  // protects: P-12 done check 5: a companion path clash is an error
  const outer = sharedFolder(t);
  for (const folder of ['one', 'two']) {
    writeModelSources(path.join(outer, folder), { 'package.json': JSON.stringify({ name: '@acme/twin', private: true }), 'twin.model.ts': PLAIN_ORDER });
  }
  const app = appWithShared(outer, 'web', false, { 'src/a.ts': 'export {};\n' }, ['src/**/*.ts', '../one/**/*.ts', '../two/**/*.ts']);

  assert.throws(() => generate({ root: app, profile: PROFILE }), new RegExp(`^Error: RUNM1078: the shared model files ${path.join(outer, 'one/twin.model.ts')} and ${path.join(outer, 'two/twin.model.ts')} have one generated file`.replace(/^Error: /, '')));
});

test('an alias in an installed package generates like a shared-folder alias, and its companion imports the package by name', (t: TestContext) => {
  // protects: P-12 done check 2: an installed package is a shared package
  const outer = createFixtureProject(t, 'golem-shared-installed-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  installSharedDeclarations(outer);
  const app = appWithShared(outer, 'web', false, { 'src/order.model.ts': SHARED_ORDER('@acme/shared/customer.model') }, ['src/**/*.ts']);

  const { artifacts } = generate({ root: app, profile: PROFILE });

  const companion = artifacts.find((artifact) => artifact.path === path.join(app, 'src/generated/models/@acme/shared/customer.model.generated.ts'));
  assert.match(companion?.content ?? '', /from "@acme\/shared\/codecs";/);
});

for (const preserveSymlinks of [false, true]) {
  test(`a shared file reached through a folder link has one codec key, and the rewrite finds its codec id and companion (preserveSymlinks ${preserveSymlinks})`, (t: TestContext) => {
    // protects: P-12 done check 1: the writer and the reader of the codec key use one real path; preserveSymlinks names the declaration by the link
    const outer = sharedFolder(t);
    const app = appWithShared(outer, 'web', false, {
      'src/order.model.ts': SHARED_ORDER('./linked/customer.model.js'),
      'src/use.ts': "import { parse } from '@exprtlabs/golem/serde';\nimport type { TCustomer } from './linked/customer.model.js';\nexport const customer = parse<TCustomer>('{}');\n",
    }, ['src/**/*.ts']);
    fs.symlinkSync('../../shared', path.join(app, 'src/linked'), 'dir');
    fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true, preserveSymlinks }, include: ['src/**/*.ts'] }));
    writeGeneratedArtifacts(generate({ root: app, profile: PROFILE }).artifacts);
    const keys: { keys: Record<string, string> } = JSON.parse(fs.readFileSync(path.join(app, '.golem/codec-keys.json'), 'utf8'));
    const id = keys.keys['../shared/customer.model.ts#TCustomer'];
    assert.match(id ?? '', /^TCustomer_[0-9a-f]{8}$/);

    const scan = scanProject({ root: app, directory: app, modelsRoot: app, output: path.join(app, 'src/generated/models'), configFile: path.join(app, 'tsconfig.json'), nest: false, codecKeysFile: path.join(app, '.golem/codec-keys.json') });

    assert.deepEqual(scan.diagnostics, []);
    const code = applyRewrites(fs.readFileSync(path.join(app, 'src/use.ts'), 'utf8'), scan.files.get('src/use.ts')!).code;
    assert.ok(code.includes(`__golem_requireObjectCodec("${id}").parse('{}')`), code);
    assert.ok(code.includes("import './generated/models/@acme/shared/customer.model.generated.js';"), code);
  });
}

for (const name of ['../escape', '/escape', 'a/../../escape']) {
  test(`a shared package.json name that leaves models.output (${name}) stops generation with an error that names the package.json`, (t: TestContext) => {
    // protects: P-12 a package name is a folder of models.output and never leaves it
    const outer = sharedFolder(t);
    fs.writeFileSync(path.join(outer, 'shared/package.json'), JSON.stringify({ name, type: 'module' }));
    const app = appWithShared(outer, 'web', false, { 'src/use.ts': "import type { TCustomer } from '../../shared/customer.model.js';\nexport type Used = TCustomer;\n" });

    assert.throws(() => generate({ root: app, profile: PROFILE }), (error: Error) => error.message.startsWith(`${path.join(fs.realpathSync(outer), 'shared/package.json')} names the package "${name}"`));
  });
}

test('a shared package.json that is not JSON stops generation with an error that names it, and never falls back to the folder name', (t: TestContext) => {
  // protects: P-12 fixing a package.json later must not move the companion folder
  const outer = sharedFolder(t);
  fs.writeFileSync(path.join(outer, 'shared/package.json'), '{ "name": ');
  const app = appWithShared(outer, 'web', false, { 'src/use.ts': "import type { TCustomer } from '../../shared/customer.model.js';\nexport type Used = TCustomer;\n" });

  assert.throws(() => generate({ root: app, profile: PROFILE }), (error: Error) => error.message.includes(`Cannot read ${path.join(fs.realpathSync(outer), 'shared/package.json')}`));
});

test('a nameless package.json under a shared package only scopes the module format: the companion goes in the named package folder', (t: TestContext) => {
  // protects: P-12 3.2 the package name is the name of the nearest package.json that has one
  const outer = sharedFolder(t);
  writeModelSources(path.join(outer, 'shared/dist/esm'), { 'package.json': '{"type":"module"}', 'order.model.ts': PLAIN_ORDER });
  const app = appWithShared(outer, 'web', false, { 'src/use.ts': 'export {};\n' });

  const { artifacts } = generate({ root: app, profile: PROFILE });

  assert.ok(artifacts.some((artifact) => artifact.path === path.join(app, 'src/generated/models/@acme/shared/dist/esm/order.model.generated.ts')));
});

test('a shared model file of the program is a watch input, and a model file of node_modules is not', (t: TestContext) => {
  // protects: P-12 watch regenerates when a shared model file changes and does not watch node_modules
  const outer = sharedFolder(t);
  const folder = appWithShared(outer, 'web', false, { 'src/order.model.ts': SHARED_ORDER('../../shared/customer.model.js') });
  installSharedDeclarations(outer);
  const installed = appWithShared(outer, 'lib', false, { 'src/order.model.ts': SHARED_ORDER('@acme/shared/customer.model') }, ['src/**/*.ts']);

  const inputs = (root: string): readonly string[] => generate({ root, profile: PROFILE }).watchInputs ?? [];

  assert.ok(inputs(folder).includes(path.join(fs.realpathSync(outer), 'shared/customer.model.ts')));
  assert.deepEqual(inputs(installed).filter((file) => file.includes('node_modules')), []);
});

test('a model file of a workspace package linked into node_modules is a watch input when preserveSymlinks names it by the link', (t: TestContext) => {
  // protects: T-208 the watch filter reads the real path: a link under node_modules to a workspace folder is no installed package
  const outer = createFixtureProject(t, 'golem-shared-linked-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  writeModelSources(path.join(outer, 'shared'), {
    'package.json': JSON.stringify({ name: '@acme/shared', private: true, type: 'module', exports: { './customer.model': { types: './customer.model.d.ts' } } }),
    'customer.model.d.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TCustomer = IModel<{ name: string }>;\n",
  });
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true, preserveSymlinks: true }, include: ['src/**/*.ts'] });
  const app = appWithShared(outer, 'lib', false, { 'src/order.model.ts': SHARED_ORDER('@acme/shared/customer.model'), 'tsconfig.json': tsconfig }, ['src/**/*.ts']);
  fs.mkdirSync(path.join(app, 'node_modules/@acme'), { recursive: true });
  fs.symlinkSync('../../../shared', path.join(app, 'node_modules/@acme/shared'), 'dir');

  const inputs = generate({ root: app, profile: PROFILE }).watchInputs ?? [];

  assert.ok(inputs.includes(path.join(app, 'node_modules/@acme/shared/customer.model.d.ts')), inputs.join('\n'));
});

test('a generated .d.ts beside the .model.d.ts file of an installed package gives one warning that names it, and the app writes its own companion', (t: TestContext) => {
  // protects: D-34 warn about a companion in an installed package, no hard reject
  const outer = createFixtureProject(t, 'golem-shared-installed-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  const declaration = installSharedDeclarations(outer);
  const published = path.join(path.dirname(declaration), 'customer.model.generated.d.ts');
  fs.writeFileSync(published, 'export {};\n');
  const app = appWithShared(outer, 'web', false, { 'src/order.model.ts': SHARED_ORDER('@acme/shared/customer.model') }, ['src/**/*.ts']);

  const { artifacts, diagnostics } = generate({ root: app, profile: PROFILE });

  assert.deepEqual(diagnostics?.map(({ code, file }) => ({ code, file })), [{ code: 'RUNM1076', file: published }]);
  assert.ok(diagnostics?.[0].message.startsWith(`${published} is a generated file beside the shared model file ${declaration}. Golem does not use it`));
  assert.ok(artifacts.some((artifact) => artifact.path === path.join(app, 'src/generated/models/@acme/shared/customer.model.generated.ts')));
});

const SDK_ORDER = "import type { IModel } from '@exprtlabs/golem/model';\nimport type { Money } from '@acme/sdk/money.model';\nexport type TOrder = IModel<{ total: Money }>;\n";

/** An SDK package at `directory`: `money.model.d.ts` holds the SDK type `Money` and an alias, and advertises the manifest, which names `Money` by `typeModule`. */
function writeSdkPackage(directory: string, typeModule: string, money = 'export interface Money { currency: string }'): void {
  writeModelSources(directory, {
    'package.json': JSON.stringify({ name: '@acme/sdk', version: '1.0.0', type: 'module', exports: { './money.model': { types: './money.model.d.ts' } } }),
    'money.model.d.ts': `/* @golem-model-manifest ./model-manifest.json */\nimport type { IObject } from '@exprtlabs/golem/model';\n${money}\nexport type Extra = IObject<{ note: string }>;\n`,
    'money.model.generated.d.ts': 'export {};\n',
    'models.ts': 'export class MoneyModel {}\nexport function stringifysdk_money(value: object, _options?: object): string { return JSON.stringify(value); }\nexport function toWireFormatsdk_money(value: unknown, _options?: object): unknown { return value; }\n',
    'model-manifest.json': JSON.stringify({
      profile: { mobx: false, validation: false, allowAny: false },
      models: [{ id: 'sdk:money', allowAny: false, type: { module: typeModule, export: 'Money' }, generated: { module: './models.ts', export: 'MoneyModel' } }],
    }),
  });
}

/** An app that nests the SDK type of `@acme/sdk`, which `place` installs or links. */
function appWithSdk(t: TestContext, place: 'installed' | 'linked', typeModule: string, money?: string, order = SDK_ORDER): string {
  const outer = createFixtureProject(t, 'golem-shared-sdk-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  if (place === 'linked') {
    writeSdkPackage(path.join(outer, 'sdk-src'), typeModule, money);
    fs.mkdirSync(path.join(outer, 'node_modules/@acme'), { recursive: true });
    fs.symlinkSync('../../sdk-src', path.join(outer, 'node_modules/@acme/sdk'), 'dir');
  } else writeSdkPackage(path.join(outer, 'node_modules/@acme/sdk'), typeModule, money);
  return appWithShared(outer, 'web', false, { 'src/order.model.ts': order }, ['src/**/*.ts']);
}

for (const place of ['installed', 'linked'] as const) {
  test(`a .model.d.ts file that a model manifest lists in an SDK package that is ${place} is an SDK file: the app uses it as an SDK, with no warning and no companion of its own`, (t: TestContext) => {
    // protects: R-20 an SDK keeps working: the manifest decides, not the folder
    const app = appWithSdk(t, place, './money.model.d.ts');

    const { artifacts, diagnostics } = generate({ root: app, profile: PROFILE });

    assert.equal(diagnostics, undefined);
    assert.deepEqual(artifacts.map((artifact) => path.relative(app, artifact.path)).filter((file) => file.includes('@acme')), []);
    assert.match(artifacts.find((artifact) => artifact.path === path.join(app, 'src/order.model.generated.ts'))?.content ?? '', /MoneyModel/);
  });
}

for (const place of ['installed', 'linked'] as const) {
  test(`an app model nests an SDK model written as an IObject alias in an SDK package that is ${place}: the companion uses the SDK codec of the manifest`, (t: TestContext) => {
    // protects: T-206 an SDK IObject alias nested in an app model generates (RUNM1053 judged the alias anonymous before the manifest was read)
    const nested = "import type { IObject } from '@exprtlabs/golem/model';\nimport type { Money } from '@acme/sdk/money.model';\nexport type TOrder = IObject<{ id: string; total: Money }>;\n";
    const app = appWithSdk(t, place, './money.model.d.ts', "export type Money = IObject<{ currency: string }>;", nested);

    const { artifacts, diagnostics } = generate({ root: app, profile: PROFILE });

    assert.equal(diagnostics, undefined);
    assert.deepEqual(artifacts.map((artifact) => path.relative(app, artifact.path)).filter((file) => file.includes('@acme')), []);
    const companion = artifacts.find((artifact) => artifact.path === path.join(app, 'src/order.model.generated.ts'))?.content ?? '';
    assert.match(companion, /stringifysdk_money/);
    assert.match(companion, /toWireFormatsdk_money/);
    assert.doesNotMatch(companion, /currency/);
  });
}

test('an anonymous IObject nested in an app model still stops generation with RUNM1053 when an SDK alias sits beside it', (t: TestContext) => {
  // protects: T-206 the manifest lookup before the anonymous check does not let a true anonymous nested model pass
  const nested = "import type { IObject } from '@exprtlabs/golem/model';\nimport type { Money } from '@acme/sdk/money.model';\nexport type TOrder = IObject<{ total: Money; note: IObject<{ text: string }> }>;\n";
  const app = appWithSdk(t, 'installed', './money.model.d.ts', "export type Money = IObject<{ currency: string }>;", nested);

  assert.throws(() => generate({ root: app, profile: PROFILE }), /RUNM1053.*named, exported declaration/);
});

/** The companion of `order.model.ts` for an app whose order has `field` of the SDK type `Money`, written as `declaration`. */
function sdkOrderCompanion(t: TestContext, declaration: string, field: string): string {
  const order = `import type { IObject } from '@exprtlabs/golem/model';\nimport type { Money } from '@acme/sdk/money.model';\nexport type TOrder = IObject<{ id: string; ${field} }>;\n`;
  const app = appWithSdk(t, 'installed', './money.model.d.ts', declaration, order);
  const { artifacts, diagnostics } = generate({ root: app, profile: PROFILE });
  assert.equal(diagnostics, undefined);
  return artifacts.find((artifact) => artifact.path === path.join(app, 'src/order.model.generated.ts'))?.content ?? '';
}

for (const field of ['total: Money | null', 'total: NonNullable<Money>', 'total: (Money | null)[]', 'total?: Money']) {
  test(`an SDK IObject alias in the field "${field}" uses the SDK codec and gives the companion of the SDK interface`, (t: TestContext) => {
    // protects: T-206 final review: an SDK alias nested in a union, NonNullable, an array or an optional field is the SDK model, never an inlined object
    const alias = sdkOrderCompanion(t, 'export type Money = IObject<{ currency: string }>;', field);
    const sdkInterface = sdkOrderCompanion(t, 'export interface Money { currency: string }', field);

    assert.match(alias, /stringifysdk_money/);
    assert.doesNotMatch(alias, /currency/);
    assert.equal(alias, sdkInterface);
  });
}

test('a .model.d.ts file of an installed package whose manifest names the .ts file is an SDK file: no warning, no companion of its own', (t: TestContext) => {
  // protects: R-20 an SDK keeps working: a published package ships .d.ts for the .ts file its manifest names
  const app = appWithSdk(t, 'installed', './money.model.ts');

  const { artifacts, diagnostics } = generate({ root: app, profile: PROFILE });

  assert.equal(diagnostics, undefined);
  assert.deepEqual(artifacts.map((artifact) => path.relative(app, artifact.path)).filter((file) => file.includes('@acme')), []);
  assert.match(artifacts.find((artifact) => artifact.path === path.join(app, 'src/order.model.generated.ts'))?.content ?? '', /MoneyModel/);
});

for (const [kind, yaml] of [['controllers', 'version: 1\ncontrollers:\n  root: .\n'], ['openapi', 'version: 1\nopenapi:\n  input: api.json\n'], ['generators', 'version: 1\ngenerators:\n  - package: x\n']] as const) {
  test(`a golem.yaml with only the ${kind} job beside a shared model file is another app: the warning says to move the model`, (t: TestContext) => {
    // protects: D-34 another app's golem.yaml warning names the way out, whichever job it has
    const { diagnostics } = generate({ root: appBesideShared(t, undefined, { 'golem.yaml': yaml }).root, profile: PROFILE });

    assert.equal(diagnostics?.length, 1);
    assert.match(diagnostics?.[0].message ?? '', /It configures another app that generates customer\.model\.ts\. Move the model into a shared package that holds no golem\.yaml/);
  });
}

for (const [shape, golemYaml] of [['is not YAML', 'models: [unclosed\n'], ['cannot be read (it is a folder)', undefined]] as const) {
  test(`a golem.yaml in a shared folder that ${shape} gives the warning, and generation goes on`, (t: TestContext) => {
    // protects: D-34 a golem.yaml that golem ignores never stops the run
    const { outer, root } = appBesideShared(t, undefined);
    const yaml = path.join(fs.realpathSync(path.join(outer, 'shared')), 'golem.yaml');
    if (golemYaml === undefined) fs.mkdirSync(yaml);
    else fs.writeFileSync(yaml, golemYaml);

    const { artifacts, diagnostics } = generate({ root, profile: PROFILE });

    assert.deepEqual(diagnostics?.map(({ code, file }) => ({ code, file })), [{ code: 'RUNM1076', file: yaml }]);
    assert.match(diagnostics?.[0].message ?? '', /Golem does not read it\. A shared package holds no golem\.yaml\. Delete it\.$/);
    assert.ok(artifacts.some((artifact) => artifact.path === path.join(root, 'src/order.model.generated.ts')));
  });
}

test('a golem run that skips the models job still writes its RUNM1076 warning, once', async (t: TestContext) => {
  // protects: P-12 done check 4: each run writes the warning once, a skipped job included
  const outer = sharedFolder(t);
  linkProjectPackages(outer, { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') });
  fs.writeFileSync(path.join(outer, 'shared/golem.yaml'), 'version: 1\n');
  const app = appWithShared(outer, 'web', false, { 'src/order.model.ts': SHARED_ORDER('../../shared/customer.model.js'), 'golem.yaml': 'version: 1\nmodels:\n  root: src\n' });

  const first = await command(app, process.execPath, [golem, 'generate']);
  const second = await command(app, process.execPath, [golem, 'generate']);

  const warning = (stderr: string): string[] => stderr.split('\n').filter((line) => line.startsWith('RUNM1076'));
  assert.equal(warning(first.stderr).length, 1, first.stderr);
  assert.deepEqual(warning(second.stderr), warning(first.stderr));
});

test('a job that generates nothing does not read the model manifests its program advertises', (t: TestContext) => {
  // protects: P-12 a models job with no alias behaves as before: a stale advertised manifest does not stop it
  const outer = createFixtureProject(t, 'golem-no-aliases-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  const app = appWithShared(outer, 'web', false, {
    'src/plain.model.ts': 'export type Plain = string;\n',
    'src/sdk/types.ts': '/* @golem-model-manifest ./missing-manifest.json */\nexport interface Money { currency: string }\n',
  }, ['src/**/*.ts']);

  assert.deepEqual(generate({ root: app, profile: PROFILE }).artifacts, []);
});
