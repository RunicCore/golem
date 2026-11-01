import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { createModelProject, buildModelProject, writeModelGolemYaml } from './model-project.js';
import { createFixtureProject, linkProjectPackages } from './fixture-project.js';
import { workspace } from './support/process.js';
import { runRewritten } from './support/rewritten-module.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { COUNT_DIST_FILES, writeCodecPackage } from './fixture-templates/models/codec-package.js';
import { tsSource } from './source-template.js';
import { generate } from '#model/generator';
import { modelCodec } from './support/model-codec.js';

function project(t: TestContext, packages: Record<string, string> = {}, options: { readonly rootDir?: string } = {}) {
  return createModelProject(t, {
    prefix: 'golem-packaged-codecs-', name: 'packaged-codecs',
    linkTypescript: true,
    packages,
    ...options,
  });
}

/** The module specifiers a generated file imports, read by running it with its imports stubbed. */
function importsOf(generated: string): readonly string[] {
  return runRewritten(generated).imports;
}

// The model's generated file imports the codecs from their package.
const MODEL_FILE = 'src/a.model.generated.ts';
const EXPORTS = { './codecs': { types: './dist/codecs.d.ts', import: './dist/codecs.js' }, './tags': { types: './dist/tags.d.ts', import: './dist/tags.js' } };
const model = taggedModelSource({ name: 'A', imports: tsSource`import type { PkgCount, PkgVarchar } from '@fixture/pg/tags';`, fields: tsSource`count: PkgCount; name: PkgVarchar<4>` }).text;

/** Builds the project, whose models job generates once, then checks the generated model file that build wrote. */
async function roundTrip(root: string): Promise<void> {
  await buildModelProject(root);
  const generated = fs.readFileSync(path.join(root, MODEL_FILE), 'utf8');
  assert.ok(importsOf(generated).includes('@fixture/pg/codecs'), 'the model imports the codecs by their package specifier');
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const decoded = modelCodec(A).fromWireFormat({ count: '42', name: 'abcd' });
  assert.equal(decoded.count, 42);
  assert.deepEqual(modelCodec(decoded).toWireFormat(decoded), { count: '42', name: 'abcd' });
}

/** A project with `@fixture/pg` installed with the given `exports` map and files, the model `A` that uses it, and the round trip of its build. */
async function writeAndRoundTrip(t: TestContext, exports: Record<string, unknown>, files: Record<string, string> = COUNT_DIST_FILES): Promise<void> {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports, files });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  writeModelGolemYaml(root, { validation: true });
  await roundTrip(root);
}

test('codec declared in an installed package dist/*.d.ts imports by package specifier', async t => {
  await writeAndRoundTrip(t, EXPORTS);
});

test('linked workspace package with source codecs imports by package specifier', async t => {
  const vendor = fs.mkdtempSync(path.join(fs.realpathSync(import.meta.dirname), '.vendor-'));
  t.after(() => fs.rmSync(vendor, { recursive: true, force: true }));
  writeCodecPackage(vendor, { name: '@fixture/pg', exports: { './codecs': './src/codecs.ts', './tags': './src/tags.ts' }, files: {
    'src/codecs.ts': `import type { Pattern } from '@exprtlabs/golem/tags';
export type CountWire = string & Pattern<'^-?\\\\d+$'>;
export function encodeCount(value: number): CountWire { return value.toString() as CountWire; }
export function decodeCount(value: CountWire): number { return Number(value); }
`,
    'src/tags.ts': COUNT_DIST_FILES['dist/tags.d.ts'],
  } });
  const { root, sourceRoot } = project(t, { '@fixture/pg': vendor });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  const generated = generate({ root, profile: { validation: true } }).artifacts.find(a => a.path.endsWith(MODEL_FILE))?.content ?? '';
  assert.ok(importsOf(generated).includes('@fixture/pg/codecs'));
});

test('a TSerde codec of a folder outside the root round-trips in an app model', async t => {
  const { root, sourceRoot } = project(t, {}, { rootDir: '..' });
  const shared = createFixtureProject(t, 'golem-shared-codecs-');
  linkProjectPackages(shared, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  fs.writeFileSync(path.join(shared, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  fs.writeFileSync(path.join(shared, 'codecs.ts'), `import type { Pattern, TSerde } from '@exprtlabs/golem/tags';
export type CountWire = string & Pattern<'^-?\\\\d+$'>;
export function encodeCount(value: number): CountWire { return value.toString() as CountWire; }
export function decodeCount(value: CountWire): number { return Number(value); }
export type PkgCount = number & TSerde<typeof encodeCount, typeof decodeCount>;
`);
  const toShared = path.relative(root, shared).split(path.sep).join('/');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, outDir: 'build', rootDir: '..' },
    include: ['src/**/*.ts', `${toShared}/**/*.ts`],
  }));
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), `import type { IModel } from '@exprtlabs/golem/model';
import type { PkgCount } from '../${toShared}/codecs.js';
import { TABaseModel, type TAFields } from './a.model.generated.js';
export type TA = IModel<{ count: PkgCount }>;
export class A extends TABaseModel { constructor(values: Partial<TAFields> = {}) { super(values); } }
`);
  writeModelGolemYaml(root, { validation: true });

  await buildModelProject(root);

  const { A } = await import(path.toNamespacedPath(path.join(root, 'build', path.basename(root), 'src/a.model.js')));
  const decoded = modelCodec(A).fromWireFormat({ count: '42' });
  assert.equal(decoded.count, 42);
  assert.deepEqual(modelCodec(decoded).toWireFormat(decoded), { count: '42' });
  assert.deepEqual(fs.readdirSync(shared).sort(), ['codecs.ts', 'node_modules', 'package.json']);
});

/**
 * A monorepo: a named root package with workspaces, a named app below it, and a `shared/` folder beside the app with a
 * `rules.ts` that only the app's model imports. `sharedManifest` is the shared folder's package.json, when it has one.
 * Returns the app's root.
 */
function monorepo(t: TestContext, sharedManifest?: Readonly<Record<string, unknown>>): string {
  const repo = createFixtureProject(t, 'golem-monorepo-');
  const web = path.join(repo, 'apps/web');
  fs.mkdirSync(path.join(web, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'shared'), { recursive: true });
  linkProjectPackages(repo, { '@exprtlabs/golem': path.join(workspace, 'packages/golem'), typescript: path.join(workspace, 'node_modules/typescript') });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'acme', private: true, type: 'module', workspaces: ['apps/*'] }));
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'web', private: true, type: 'module' }));
  fs.writeFileSync(path.join(web, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, outDir: 'build', rootDir: '../..' },
    include: ['src/**/*.ts', '../../shared/**/*.ts'],
  }));
  if (sharedManifest) fs.writeFileSync(path.join(repo, 'shared/package.json'), JSON.stringify(sharedManifest));
  fs.writeFileSync(path.join(repo, 'shared/rules.ts'), "export function isCurrencyCode(value: string): boolean | string { return /^[A-Z]{3}$/.test(value) || 'must be a currency code'; }\n");
  fs.writeFileSync(path.join(web, 'src/a.model.ts'), tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import type { isCurrencyCode } from '../../../shared/rules.js';
export type TA = IObject<{ currency: string & TValidation<typeof isCurrencyCode> }>;
`.text);
  return web;
}

test('a shared folder with no name of its own keeps its functions relative when only the named root above the app owns it', t => {
  const web = monorepo(t);
  const artifacts = generate({ root: web, profile: { validation: true } }).artifacts;
  const validators = artifacts.find(a => a.path.endsWith('models.validators.generated.ts'))?.content ?? '';
  assert.ok(importsOf(validators).some((specifier) => /^(\.\.\/)+shared\/rules\.js$/.test(specifier)), importsOf(validators).join('\n'));
});

test('RUNM1060 when a shared folder with its own name has no export that reaches the function', t => {
  const web = monorepo(t, { name: '@acme/shared', version: '0.0.0', type: 'module' });
  assert.throws(() => generate({ root: web, profile: { validation: true } }), /RUNM1060: .*isCurrencyCode.*@acme\/shared.*rules\.ts/);
});

test('a TValidation predicate that only an installed package declares checks the field directly and through its tag alias', async t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/rules'), {
    name: '@fixture/rules',
    exports: { './rules': { types: './dist/rules.d.ts', import: './dist/rules.js' }, './tags': { types: './dist/tags.d.ts', import: './dist/tags.js' } },
    files: {
      'dist/rules.d.ts': 'export declare function isEven(value: number): boolean | string;\n',
      'dist/rules.js': "export function isEven(value) { return value % 2 === 0 || 'must be even'; }\n",
      'dist/tags.d.ts': tsSource`import type { TValidation } from '@exprtlabs/golem/tags';
import type { isEven } from './rules.js';
export type EvenCount = number & TValidation<typeof isEven>;
`.text,
      'dist/tags.js': 'export {};\n',
    },
  });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import type { isEven } from '@fixture/rules/rules';
import type { EvenCount } from '@fixture/rules/tags';
export type TA = IObject<{ viaAlias: EvenCount; direct: number & TValidation<typeof isEven> }>;
`.text);
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const { parseTA } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.generated.js')));

  assert.deepEqual(parseTA('{"viaAlias":2,"direct":4}'), { viaAlias: 2, direct: 4 });
  assert.throws(() => parseTA('{"viaAlias":3,"direct":4}'), (error: unknown) => {
    assert.ok(error instanceof LibError && error.kind === LibErrorKind.Validation);
    assert.deepEqual(error.issues.map(({ path, message }) => ({ path, message })), [{ path: ['viaAlias'], message: 'must be even' }]);
    return true;
  });
  assert.throws(() => parseTA('{"viaAlias":2,"direct":5}'), (error: unknown) => {
    assert.ok(error instanceof LibError && error.kind === LibErrorKind.Validation);
    assert.deepEqual(error.issues.map(({ path, message }) => ({ path, message })), [{ path: ['direct'], message: 'must be even' }]);
    return true;
  });
});

test('wildcard export reaches the codec', async t => {
  await writeAndRoundTrip(t, { './*': { types: './dist/*.d.ts', import: './dist/*.js' } });
});

test('two codecs from one package share one specifier', t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: EXPORTS, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { PkgCount } from '@fixture/pg/tags';`, fields: tsSource`one: PkgCount; two: PkgCount[]` }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.find(a => a.path.endsWith(MODEL_FILE))?.content ?? '';
  assert.equal([...generated.matchAll(/import \{ encodeCount as /g)].length, 1);
  assert.equal([...generated.matchAll(/from "@fixture\/pg\/codecs"/g)].length, 1); // the encode and the decode share one import
});

test('RUNM1060 when no export reaches the codec', t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: { './tags': EXPORTS['./tags'] }, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  assert.throws(() => generate({ root, profile: { validation: true } }), error => {
    assert.match(String(error), /RUNM1060: .*encodeCount.*@fixture\/pg.*dist\/codecs\.d\.ts/);
    return true;
  });
});

test('a package with no exports field hosts a codec at its package-relative path', async t => {
  // protects: F-52 a TSerde function in a package with no exports field is importable by deep path, as Node allows
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { PkgCount } from '@fixture/pg/dist/tags.js';`, fields: tsSource`count: PkgCount` }).text);
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const generated = fs.readFileSync(path.join(root, MODEL_FILE), 'utf8');
  assert.ok(importsOf(generated).includes('@fixture/pg/dist/codecs.js'));
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  assert.deepEqual(modelCodec(A).toWireFormat(modelCodec(A).fromWireFormat({ count: '42' })), { count: '42' });
});

test('exports without a types condition reach the declaration file beside each target', async t => {
  await writeAndRoundTrip(t, { './codecs': './dist/codecs.js', './tags': './dist/tags.js' });
});

test('a nameless nested package.json inside the codec package does not hide the package', async t => {
  await writeAndRoundTrip(t, EXPORTS, { ...COUNT_DIST_FILES, 'dist/package.json': '{"type":"module"}' });
});

test('a nameless package.json in the project keeps project codecs relative', t => {
  const { root, sourceRoot } = project(t);
  fs.mkdirSync(path.join(sourceRoot, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'models'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'lib/codecs.ts'), "export function encodeCount(value: number): string { return String(value); }\nexport function decodeCount(value: string): number { return Number(value); }\n");
  fs.writeFileSync(path.join(sourceRoot, 'models/package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(sourceRoot, 'models/a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';\nimport { encodeCount, decodeCount } from '../lib/codecs.js';\ntype Count = number & TSerde<typeof encodeCount, typeof decodeCount>;`, fields: tsSource`count: Count` }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.find(a => a.path.endsWith('src/models/a.model.generated.ts'))?.content ?? '';
  assert.ok(importsOf(generated).includes('../lib/codecs.js'));
});

test('an edited package.json is read again by the next generation in the same process', t => {
  const { root, sourceRoot } = project(t);
  const packageRoot = path.join(root, 'node_modules/@fixture/pg');
  writeCodecPackage(packageRoot, { name: '@fixture/pg', exports: { './tags': EXPORTS['./tags'] }, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  assert.throws(() => generate({ root, profile: { validation: true } }), /RUNM1060/);
  writeCodecPackage(packageRoot, { name: '@fixture/pg', exports: EXPORTS, files: {} });
  assert.doesNotThrow(() => generate({ root, profile: { validation: true } }));
});

test('a malformed package.json names its path and keeps the parse error as the cause', t => {
  const { root, sourceRoot } = project(t);
  const packageRoot = path.join(root, 'node_modules/@fixture/pg');
  writeCodecPackage(packageRoot, { name: '@fixture/pg', exports: EXPORTS, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(packageRoot, 'dist/package.json'), '{"type": ');
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  assert.throws(() => generate({ root, profile: { validation: true } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path.join(packageRoot, 'dist/package.json')), error.message);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});

// The codec files one directory deeper, for the exports rules that depend on where a file sits.
const NESTED_FILES = Object.fromEntries(Object.entries(COUNT_DIST_FILES).map(([name, text]) => [name.replace('dist/', 'dist/sub/'), text]));
const NESTED_TAGS = { './sub/tags': { types: './dist/sub/tags.d.ts', import: './dist/sub/tags.js' } };

function generatedFor(t: TestContext, exports: Record<string, unknown>, nested = false): string {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports, files: nested ? NESTED_FILES : COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), nested ? model.replace('@fixture/pg/tags', '@fixture/pg/sub/tags') : model);
  return generate({ root, profile: { validation: true } }).artifacts.find(a => a.path.endsWith(MODEL_FILE))?.content ?? '';
}

function rejected(t: TestContext, exports: Record<string, unknown>, nested = false): void {
  assert.throws(() => generatedFor(t, exports, nested), /RUNM1060: .*encodeCount.*@fixture\/pg/);
}

test('exports: the most specific pattern decides, so a file the specific pattern sends elsewhere is not exported', t => {
  rejected(t, { ...NESTED_TAGS, './*': './dist/*.d.ts', './sub/*': './dist/legacy/*.d.ts' }, true);
});

test('exports: a file reached through the most specific pattern gets that pattern\'s subpath', t => {
  const generated = generatedFor(t, { ...NESTED_TAGS, './*': './dist/legacy/*.d.ts', './sub/*': './dist/sub/*.d.ts' }, true);
  assert.ok(importsOf(generated).includes('@fixture/pg/sub/codecs'));
});

test('exports: a null target excludes the file even when a pattern would reach it', t => {
  rejected(t, { './tags': EXPORTS['./tags'], './*': './dist/*.d.ts', './codecs': null });
});

test('exports: a null condition excludes the file', t => {
  rejected(t, { './tags': EXPORTS['./tags'], './codecs': { import: null, types: './dist/codecs.d.ts' } });
});

test('exports: the first matching condition wins, as in Node', t => {
  rejected(t, { './tags': EXPORTS['./tags'], './codecs': { default: './dist/other.d.ts', types: './dist/codecs.d.ts' } });
});

test('exports: conditions golem does not use are skipped', t => {
  rejected(t, { './tags': EXPORTS['./tags'], './codecs': { custom: './dist/codecs.d.ts', require: './dist/codecs.js' } });
  const generated = generatedFor(t, { './tags': EXPORTS['./tags'], './codecs': { custom: './dist/nowhere.d.ts', types: './dist/codecs.d.ts' } });
  assert.ok(importsOf(generated).includes('@fixture/pg/codecs'));
});

test('one package installed at two paths collapses to one binding', t => {
  const { root, sourceRoot } = project(t);
  // `dep` carries its own copy of @fixture/pg, so the same package is reached by two file paths.
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: EXPORTS, files: COUNT_DIST_FILES });
  writeCodecPackage(path.join(root, 'node_modules/dep'), { name: 'dep', exports: { '.': { types: './index.d.ts' } }, files: { 'index.d.ts': "export type { PkgCount as DepCount } from '@fixture/pg/tags';\n" } });
  writeCodecPackage(path.join(root, 'node_modules/dep/node_modules/@fixture/pg'), { name: '@fixture/pg', exports: EXPORTS, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { PkgCount } from '@fixture/pg/tags';\nimport type { DepCount } from 'dep';`, fields: tsSource`one: PkgCount; two: DepCount` }).text);
  const generated = generate({ root, profile: { validation: true } }).artifacts.find(a => a.path.endsWith(MODEL_FILE))?.content ?? '';
  assert.equal([...generated.matchAll(/\bencodeCount as /g)].length, 1);
  assert.equal([...generated.matchAll(/\bdecodeCount as /g)].length, 1);
});
