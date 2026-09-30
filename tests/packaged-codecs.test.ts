import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { writeGeneratedArtifacts } from './fixture-project.js';
import { createModelProject, compileModelProject } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { COUNT_DIST_FILES, writeCodecPackage } from './fixture-templates/models/codec-package.js';
import { tsSource } from './source-template.js';
import { generate } from '#model/generator';

const workspace = path.resolve(import.meta.dirname, '../..');

function project(t: TestContext, packages: Record<string, string> = {}) {
  return createModelProject(t, {
    prefix: 'golem-packaged-codecs-', name: 'packaged-codecs', ttscPlugin: true,
    linkTypescript: true, linkTtsc: true,
    packages: { ajv: path.join(workspace, 'node_modules/ajv'), 'ajv-formats': path.join(workspace, 'node_modules/ajv-formats'), ...packages },
  });
}

// Codec imports are emitted into the shared models file, not the model's companion.
const SHARED_MODELS = 'src/generated/models/models.generated.ts';
const EXPORTS = { './codecs': { types: './dist/codecs.d.ts', import: './dist/codecs.js' }, './tags': { types: './dist/tags.d.ts', import: './dist/tags.js' } };
const model = taggedModelSource({ name: 'A', imports: tsSource`import type { PkgCount, PkgVarchar } from '@fixture/pg/tags';`, fields: tsSource`count: PkgCount; name: PkgVarchar<4>` }).text;

async function roundTrip(root: string): Promise<void> {
  const generated = fs.readFileSync(path.join(root, SHARED_MODELS), 'utf8');
  assert.match(generated, /from "@fixture\/pg\/codecs"/);
  assert.doesNotMatch(generated, /node_modules|\.d\.js/);
  await compileModelProject(root);
  const { A } = await import(path.toNamespacedPath(path.join(root, 'build/a.model.js')));
  const decoded = decodeGeneratedModel(A, { count: '42', name: 'abcd' });
  assert.equal(decoded.count, 42);
  assert.deepEqual(encodeGeneratedModel(decoded), { count: '42', name: 'abcd' });
}

test('codec declared in an installed package dist/*.d.ts imports by package specifier', async t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: EXPORTS, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await roundTrip(root);
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
  const generated = generate({ root, profile: { mobx: false, validation: true } }).artifacts.find(a => a.path.endsWith(SHARED_MODELS))?.content ?? '';
  assert.match(generated, /from "@fixture\/pg\/codecs"/);
});

test('wildcard export reaches the codec', async t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: { './*': { types: './dist/*.d.ts', import: './dist/*.js' } }, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await roundTrip(root);
});

test('two codecs from one package share one specifier', t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: EXPORTS, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { PkgCount } from '@fixture/pg/tags';`, fields: tsSource`one: PkgCount; two: PkgCount[]` }).text);
  const generated = generate({ root, profile: { mobx: false, validation: true } }).artifacts.find(a => a.path.endsWith(SHARED_MODELS))?.content ?? '';
  assert.equal([...generated.matchAll(/import \{ encodeCount as /g)].length, 1);
  assert.equal([...generated.matchAll(/from "@fixture\/pg\/codecs"/g)].length, 2); // one encode, one decode import
});

test('RUNM1060 when no export reaches the codec', t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: { './tags': EXPORTS['./tags'] }, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), error => {
    assert.match(String(error), /RUNM1060: .*encodeCount.*@fixture\/pg.*dist\/codecs\.d\.ts/);
    return true;
  });
});

test('exports without a types condition reach the declaration file beside each target', async t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: { './codecs': './dist/codecs.js', './tags': './dist/tags.js' }, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await roundTrip(root);
});

test('a nameless nested package.json inside the codec package does not hide the package', async t => {
  const { root, sourceRoot } = project(t);
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports: EXPORTS, files: { ...COUNT_DIST_FILES, 'dist/package.json': '{"type":"module"}' } });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  writeGeneratedArtifacts(generate({ root, profile: { mobx: false, validation: true } }).artifacts);
  await roundTrip(root);
});

test('a nameless package.json in the project keeps project codecs relative', t => {
  const { root, sourceRoot } = project(t);
  fs.mkdirSync(path.join(sourceRoot, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'models'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'lib/codecs.ts'), "export function encodeCount(value: number): string { return String(value); }\nexport function decodeCount(value: string): number { return Number(value); }\n");
  fs.writeFileSync(path.join(sourceRoot, 'models/package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(sourceRoot, 'models/a.model.ts'), taggedModelSource({ name: 'A', imports: tsSource`import type { TSerde } from '@exprtlabs/golem/tags';\nimport { encodeCount, decodeCount } from '../lib/codecs.js';\ntype Count = number & TSerde<typeof encodeCount, typeof decodeCount>;`, fields: tsSource`count: Count` }).text);
  const generated = generate({ root, profile: { mobx: false, validation: true } }).artifacts.find(a => a.path.endsWith(SHARED_MODELS))?.content ?? '';
  assert.match(generated, /from "\.\.\/\.\.\/lib\/codecs\.js"/);
});

test('an edited package.json is read again by the next generation in the same process', t => {
  const { root, sourceRoot } = project(t);
  const packageRoot = path.join(root, 'node_modules/@fixture/pg');
  writeCodecPackage(packageRoot, { name: '@fixture/pg', exports: { './tags': EXPORTS['./tags'] }, files: COUNT_DIST_FILES });
  fs.writeFileSync(path.join(sourceRoot, 'a.model.ts'), model);
  assert.throws(() => generate({ root, profile: { mobx: false, validation: true } }), /RUNM1060/);
  writeCodecPackage(packageRoot, { name: '@fixture/pg', exports: EXPORTS, files: {} });
  assert.doesNotThrow(() => generate({ root, profile: { mobx: false, validation: true } }));
});
