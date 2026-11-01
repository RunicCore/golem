import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { command, workspace } from './support/process.js';
import { spyOnBuild } from './support/build-spy.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { marker } from '#golem/outputs';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/internal/model-runtime';
import { getValidator } from '@exprtlabs/golem/validation';

import { copyFixture, copyFixtureFile, createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from './fixture-project.js';
import { accountModelWithField, accountModelWithMissingImport } from './fixture-templates/models/model-generator.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { COUNT_DIST_FILES, writeCodecPackage } from './fixture-templates/models/codec-package.js';
import { tsSource } from './source-template.js';
import { resolveConfig } from '#golem/config';
import { JobRuleError } from '#golem/job-rules';

import {
  apiVersion,
  discoverModelSources,
  generate,
} from '#model/generator';
import { modelCodec } from './support/model-codec.js';

function project(t: TestContext) {
  return createModelProject(t, { prefix: 'golem-model-generator-', name: 'model-generator' });
}

function profileCases(): readonly [{ mobx?: boolean; validation: boolean }, { mobx?: boolean; validation: boolean }][] {
  return [
    [{ validation: false }, { validation: false }],
    [{ mobx: true, validation: false }, { mobx: true, validation: false }],
    [{ validation: true }, { validation: true }],
    [{ mobx: true, validation: true }, { mobx: true, validation: true }],
  ];
}

/** The paths of the model companions among the generated artifacts. */
function generatedModelPaths(artifacts: ReturnType<typeof generate>['artifacts']): string[] {
  return artifacts.map(artifact => artifact.path).filter(file => file.endsWith('.model.generated.ts'));
}

const isValidationUnavailable = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable;

for (const [profile, expected] of profileCases()) {
  test(`exports API 1 and emits the model companions of mobx ${profile.mobx} validation ${profile.validation} without writes`, async (t: TestContext) => {
    // protects: a profile writes exactly the files it needs, and the built companions run with that profile's validators and MobX hooks
    const { root, sourceRoot } = project(t);
    const source = copyFixtureFile(root, 'models/model-generator/api-profiles/src/payment.model.ts', 'src/payment.model.ts');
    const { isComputedProp } = await import('mobx');
    assert.equal(apiVersion, 1);
    const result = generate({ root, sources: [source], profile });
    assert.deepEqual(result.manifestPaths, []);
    // Every job writes the companion and the codec keys. A validating job also writes the generated validators.
    assert.equal(result.artifacts.length, expected.validation ? 3 : 2);
    assert.equal(
      result.artifacts.some(artifact => artifact.path.endsWith('models.validators.generated.ts')),
      expected.validation,
      'the validators file is written exactly when the profile validates',
    );
    assert.ok(result.artifacts.some(artifact => artifact.path === path.join(sourceRoot, 'payment.model.generated.ts')));
    assert.equal(fs.existsSync(path.join(sourceRoot, 'payment.model.generated.ts')), false);
    // golem retires or replaces a file only while it recognizes its owner's marker. The codec key table is core's own record and carries none.
    const jobFiles = result.artifacts.filter(artifact => path.basename(artifact.path) !== 'codec-keys.json');
    for (const artifact of jobFiles) assert.equal(marker(artifact.content, '@exprtlabs/golem-model'), true, path.basename(artifact.path));

    // The same profile, built and run. An import or a MobX hook the profile does not use fails the strict unused compile.
    const built = createModelProject(t, { prefix: 'golem-model-generator-built-', name: 'model-generator-built', compilerOptions: { noUnusedLocals: true } });
    writeModelSources(built.sourceRoot, {
      'money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TMoney = IObject<{ currency: string & MinLength<3> }>;
`,
      'payment.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem-openapi-ts/mobx';
import type { TMoney } from './money.model.js';
import { TPaymentBaseModel } from './payment.model.generated.js';
export type TPayment = IModel<{ id: string; amount: number; total: TMoney }>;
// A second asGenObservable call on one instance throws: the generated base never makes the model observable itself.
export class Payment extends TPaymentBaseModel {
  constructor(values: ConstructorParameters<typeof TPaymentBaseModel>[0] = {}) { super(values); asGenObservable(this); }
}
`,
      'fields-assert.ts': tsSource`import type { generatedModelFieldsBrand } from '@exprtlabs/golem/model';
import type { Payment } from './payment.model.js';
export const fields: Payment[typeof generatedModelFieldsBrand] = { id: 'a', amount: 1, total: { currency: 'USD' } };
// @ts-expect-error the fields brand carries the declared field types
export const wrong: Payment[typeof generatedModelFieldsBrand] = { id: 1, amount: 1, total: { currency: 'USD' } };
`,
    });
    writeModelGolemYaml(built.root, profile);
    await buildModelProject(built.root);
    const { Payment } = await import(`${pathToFileURL(path.join(built.root, 'build/payment.model.js')).href}`);
    const wire = { id: 'p1', amount: 5, total: { currency: 'USD' } };
    const payment = modelCodec(Payment).fromWireFormat(wire);
    assert.ok(payment instanceof Payment, 'the companion registers the model for conversion');
    assert.deepEqual(modelCodec(payment).toWireFormat(payment), wire);
    const codec = requireObjectCodec(generatedCodecIdFromRoot(built.root, 'TPayment'));
    // A validating app rejects the short nested currency when it parses; an app without validation reads the same text.
    const shortCurrency = JSON.stringify({ ...wire, total: { currency: 'US' } });
    if (expected.validation) {
      assert.throws(() => codec.parse(shortCurrency));
      const validator = getValidator(payment);
      assert.equal(await validator.validate(), true);
      assert.equal(await getValidator(new Payment({ id: 'p1', amount: 'five', total: wire.total })).validate(), false);
      assert.equal(isComputedProp(validator, 'valid'), expected.mobx, 'the validator is observable exactly when the profile uses MobX');
      assert.equal(codec.validate(payment), true);
    } else {
      assert.deepEqual(codec.parse(shortCurrency), { ...wire, total: { currency: 'US' } });
      assert.throws(() => getValidator(payment), isValidationUnavailable);
      assert.throws(() => codec.validate(payment), isValidationUnavailable);
    }
  });
}

test('getValidator infers generated fields and rejects handwritten subclass fields', async (t: TestContext) => {
  const { root } = project(t);
  copyFixture(root, 'models/model-generator/validation-fields');
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
});

test('discovers model sources, reports project inputs, and excludes generated companions', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  const source = path.join(sourceRoot, 'nested', 'account.models.ts');
  writeModelSources(sourceRoot, {
    'nested/account.models.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TAccount = IModel<{ id: string }>;`,
  });
  assert.deepEqual(discoverModelSources(root), [source]);
  const result = generate({ root, profile: { validation: false } });
  assert.deepEqual(result.artifacts.map((artifact) => artifact.path).sort(), [path.join(root, '.golem/codec-keys.json'), path.join(sourceRoot, 'nested/account.models.generated.ts')], 'the run writes the companion and the codec keys under .golem/');
  assert.deepEqual(result.watchInputs, [source, path.join(root, 'tsconfig.json')]);
  assert.equal(result.watchInputs.some((filename) => filename.endsWith('.generated.ts')), false);
});

test('a model named with a non-ASCII letter generates a companion that keeps the name', (t: TestContext) => {
  // protects: T-290 a user model name may hold any Unicode letter, as it did before Code values
  const { root, sourceRoot } = project(t);
  const source = path.join(sourceRoot, 'cafe.model.ts');
  fs.writeFileSync(source, "import type { IModel } from '@exprtlabs/golem/model';\nexport type TCafé = IModel<{ label: string }>;\n");
  const result = generate({ root, sources: [source], profile: { validation: true } });
  assert.ok(result.artifacts.some(artifact => artifact.content.includes('TCaféBaseModel')));
});

test('rejects missing sources and profile-mismatched manifests before emitting artifacts', (t: TestContext) => {
  // protects: T-326 an empty sources list stops with a message that names `sources`, not context.sources
  const { root, sourceRoot } = project(t);
  const manifest = path.join(root, 'external-model-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    profile: { validation: true, allowAny: false },
    models: [],
  }));
  assert.throws(
    () => generate({ root, profile: { validation: false }, manifestInputs: [manifest], sources: [] }),
    (error: Error) => /`sources` is empty.*List at least one model file in `sources`/.test(error.message) && !/context\./.test(error.message),
  );
  const source = copyFixtureFile(root, 'models/model-generator/api-profiles/src/payment.model.ts', 'src/x.model.ts');
  assert.throws(
    () => generate({ root, sources: [source], profile: { validation: false }, manifestInputs: [manifest] }),
    /profile mismatch/,
  );
  const profile = { validation: true, allowAny: false };
  fs.writeFileSync(manifest, JSON.stringify({ profile: { ...profile, allowAny: true }, models: [] }));
  assert.throws(() => generate({ root, sources: [source], profile, manifestInputs: [manifest] }), /profile mismatch/);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'x.model.generated.ts')), false);
  fs.writeFileSync(manifest, JSON.stringify({ profile: { ...profile, unknownFormats: 'warn' }, models: [] }));
  assert.throws(() => generate({ root, sources: [source], profile, manifestInputs: [manifest] }), /profile mismatch.*unknownFormats: error/);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'x.model.generated.ts')), false);
});

test('an SDK manifest with no unknownFormats record is a profile mismatch that says to regenerate', (t: TestContext) => {
  // protects: T-33 a manifest written before unknownFormats defaulted to error is not a match
  const { root, sourceRoot } = project(t);
  const manifest = path.join(root, 'external-model-manifest.json');
  const source = copyFixtureFile(root, 'models/model-generator/api-profiles/src/payment.model.ts', 'src/x.model.ts');
  const profile = { validation: true, allowAny: false };
  fs.writeFileSync(manifest, JSON.stringify({ profile, models: [] }));
  assert.throws(
    () => generate({ root, sources: [source], profile, manifestInputs: [manifest] }),
    /profile mismatch.*unknownFormats: error.*Regenerate the SDK manifest with the same profile/,
  );
  assert.equal(fs.existsSync(path.join(sourceRoot, 'x.model.generated.ts')), false);
});

test('a profile mismatch names each setting that differs and how to align it', (t) => {
  // protects: T-490 the message gave the whole expected profile and left the reader to find the differing setting
  const { root } = project(t);
  const manifest = path.join(root, 'external-model-manifest.json');
  const source = copyFixtureFile(root, 'models/model-generator/api-profiles/src/payment.model.ts', 'src/x.model.ts');
  const profile = { validation: true, allowAny: false };
  fs.writeFileSync(manifest, JSON.stringify({ profile: { ...profile, validation: false, unknownFormats: 'warn' }, models: [] }));
  assert.throws(
    () => generate({ root, sources: [source], profile, manifestInputs: [manifest] }),
    (error: Error) => error.message.includes('validation: manifest false, project true; unknownFormats: manifest warn, project error.')
      && /Regenerate the SDK manifest with the same profile before model generation, or set the project to the manifest value in golem\.yaml\.$/.test(error.message)
      && !error.message.includes('mobx: manifest'),
  );
});

test('prospective companions permit a concrete subclass field rename and still reject unrelated errors', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  const source = path.join(sourceRoot, 'account.model.ts');
  writeModelSources(sourceRoot, { 'account.model.ts': accountModelWithField({ field: 'done' }) });
  const first = generate({ root, sources: [source], profile: { validation: true } });
  writeGeneratedArtifacts(first.artifacts);
  writeModelSources(sourceRoot, { 'account.model.ts': accountModelWithField({ field: 'complete' }) });
  const second = generate({ root, sources: [source], profile: { validation: true } });
  // The validating job writes the companion, the codec keys and the generated validators.
  assert.equal(second.artifacts.length, 3);
  writeModelSources(sourceRoot, { 'account.model.ts': accountModelWithMissingImport({ field: 'complete' }) });
  assert.throws(
    () => generate({ root, sources: [source], profile: { validation: true } }),
    /unrelated-missing-module/,
  );
});

test('generated validation executes local references and exact-object rules', async (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  copyFixture(root, 'models/model-generator/exact-rules');
  writeModelSources(sourceRoot, {
    'abstract-assert.ts': tsSource`import { TPaymentBaseModel } from './models.model.generated.js';
// @ts-expect-error a generated base class is abstract: a handwritten class extends it
export const construct = () => new TPaymentBaseModel();
`,
  });
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const paymentId = generatedCodecIdFromRoot(root, 'TPayment');
  const verifier = path.join(root, 'verify.mjs');
  await command(root, process.execPath, [verifier, paymentId]);
});

test('rejects unsupported and duplicate model manifests', (t: TestContext) => {
  const { root } = project(t);
  const source = copyFixtureFile(root, 'models/model-generator/api-profiles/src/payment.model.ts', 'src/payment.model.ts');
  const first = path.join(root, 'first-model-manifest.json');
  const second = path.join(root, 'second-model-manifest.json');
  const model = {
    id: 'fixture:money',
    codecId: 'Money_0a1b2c3d',
    allowAny: false,
    type: { module: './types.ts', export: 'Money' },
  };
  const manifest = (profile: { mobx?: boolean; validation: boolean }) => ({
    profile: { ...profile, allowAny: false, unknownFormats: 'error' },
    models: [model],
  });
  fs.writeFileSync(first, JSON.stringify({ ...manifest({ validation: false }), manifestVersion: 99 }));
  assert.throws(
    () => generate({ root, sources: [source], profile: { validation: false }, manifestInputs: [first] }),
    /Outdated model manifest/,
  );
  fs.writeFileSync(first, JSON.stringify(manifest({ validation: false })));
  fs.writeFileSync(second, JSON.stringify(manifest({ validation: false })));
  assert.throws(
    () => generate({ root, sources: [source], profile: { validation: false }, manifestInputs: [first, second] }),
    /Duplicate model manifest id/,
  );
});

test('a job leaves the real companions of other jobs under the same tsconfig alone', (t: TestContext) => {
  // One tsconfig covers both jobs' sources. Job two's program holds job one's handwritten class, which extends the
  // base class of job one's companion; only job one's own run may replace that companion.
  const { root } = createModelProject(t, { prefix: 'golem-two-jobs-', name: 'two-jobs', rootDir: '.', include: ['jobs/*/src/**/*.ts'] });
  const profile = { validation: true } as const;
  for (const job of ['one', 'two']) {
    const jobRoot = path.join(root, 'jobs', job);
    writeModelSources(path.join(jobRoot, 'src'), { 'item.model.ts': taggedModelSource({ name: 'Item', fields: tsSource`name: string` }) });
    writeGeneratedArtifacts(generate({ root: jobRoot, profile }).artifacts);
    assert.ok(fs.existsSync(path.join(jobRoot, 'src/item.model.generated.ts')), `job ${job} wrote its companion`);
  }
});

/** A create-vite style solution: the root tsconfig lists no files and references the project that does. */
function solutionProject(t: TestContext, references: readonly string[]): { readonly root: string; readonly sourceRoot: string } {
  const created = project(t);
  // Comments and trailing commas are valid in a tsconfig, so the solution carries both.
  fs.writeFileSync(
    path.join(created.root, 'tsconfig.json'),
    `// The solution lists no files.\n{ "files": [], /* projects: */ "references": [${references.map(reference => `{ "path": ${JSON.stringify(reference)}, }`).join(', ')},], }\n`,
  );
  fs.writeFileSync(path.join(created.root, 'tsconfig.app.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'],
      paths: { '@lib/*': ['./src/lib/*'] },
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  }));
  fs.writeFileSync(path.join(created.root, 'tsconfig.other.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['other/**/*.ts'] }));
  return created;
}

test('a solution tsconfig generates with the options of the referenced project that holds the model', (t: TestContext) => {
  const { root, sourceRoot } = solutionProject(t, ['./tsconfig.other.json', './tsconfig.app.json']);
  writeModelSources(sourceRoot, {
    // The alias needs the app project's paths and Blob its DOM lib; the solution root has neither.
    'lib/ids.ts': 'export type Id = string;\nexport const sizeOf = (blob: Blob): number => blob.size;\n',
    'item.model.ts': taggedModelSource({ name: 'Item', imports: tsSource`import type { Id } from '@lib/ids';`, fields: tsSource`id: Id` }),
  });
  const result = generate({ root, profile: { validation: true } });
  assert.ok(generatedModelPaths(result.artifacts).includes(path.join(sourceRoot, 'item.model.generated.ts')));
});

test('a solution tsconfig that starts with a byte-order mark generates with the options of the referenced project', (t: TestContext) => {
  const { root, sourceRoot } = solutionProject(t, ['./tsconfig.other.json', './tsconfig.app.json']);
  const solution = path.join(root, 'tsconfig.json');
  fs.writeFileSync(solution, `\uFEFF${fs.readFileSync(solution, 'utf8')}`);
  writeModelSources(sourceRoot, {
    'lib/ids.ts': 'export type Id = string;\n',
    'item.model.ts': taggedModelSource({ name: 'Item', imports: tsSource`import type { Id } from '@lib/ids';`, fields: tsSource`id: Id` }),
  });
  const result = generate({ root, profile: { validation: true } });
  assert.ok(generatedModelPaths(result.artifacts).includes(path.join(sourceRoot, 'item.model.generated.ts')));
});

test('a solution tsconfig whose references hold no model source names the solution and the source', (t: TestContext) => {
  const { root, sourceRoot } = solutionProject(t, ['./tsconfig.other.json']);
  writeModelSources(sourceRoot, { 'item.model.ts': taggedModelSource({ name: 'Item', fields: tsSource`id: string` }) });
  assert.throws(
    () => generate({ root, profile: { validation: true } }),
    (error: unknown) => error instanceof Error
      && error.message.includes(path.join(root, 'tsconfig.json'))
      && error.message.includes(path.join(sourceRoot, 'item.model.ts')),
  );
});

test('a project root reached through a symlink opens its own project', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, { 'item.model.ts': taggedModelSource({ name: 'Item', fields: tsSource`id: string` }) });
  const alias = path.join(createFixtureProject(t, 'golem-root-alias-'), 'alias');
  fs.symlinkSync(root, alias, 'dir');
  const result = generate({ root: alias, profile: { validation: true } });
  assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('item.model.generated.ts')));
});

test('model generation reports source type errors with the path relative to the working directory, the line, the column and the TS code', (t: TestContext) => {
  // protects: T-312 diagnostics print paths relative to the working directory, as tsc does
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-generate-diagnostics-', linkTypescript: true });
  const broken = path.join(sourceRoot, 'broken.model.ts');
  fs.writeFileSync(broken, `import type { IModel } from '@exprtlabs/golem/model';
const wrong: string = 5;
export type TBroken = IModel<{ id: string }>;
export { wrong };
`);
  assert.throws(
    () => generate({ root, profile: { validation: false } }),
    (error: unknown) => error instanceof Error && error.message.startsWith(`${path.relative(process.cwd(), broken)}(2,7): error TS2322: Type 'number' is not assignable to type 'string'.`),
  );
});

test('a type error in a handwritten file that is not a model source does not stop generation', (t: TestContext) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-generate-unrelated-error-', linkTypescript: true, compilerOptions: { declaration: false } });
  writeModelSources(sourceRoot, { 'item.model.ts': taggedModelSource({ name: 'Item', fields: tsSource`id: string` }) });
  fs.writeFileSync(path.join(sourceRoot, 'unrelated.ts'), "export const wrong: string = 5;\nexport const Anonymous = class { private x = 1; };\n");
  const result = generate({ root, profile: { validation: false } });
  assert.ok(result.artifacts.some(artifact => artifact.path.endsWith('item.model.generated.ts')), 'the companion is generated; the compiler reports the other file');
});

test('a type error in a generated companion stops generation and is reported with path(line,col)', (t: TestContext) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-generate-companion-error-', linkTypescript: true });
  writeModelSources(sourceRoot, { 'item.model.ts': taggedModelSource({ name: 'Item', fields: tsSource`id: string` }) });
  // A handwritten module augmentation makes the generated class stop implementing the interface it implements, so the error sits in the companion.
  fs.writeFileSync(path.join(sourceRoot, 'augment.ts'), `import '@exprtlabs/golem/model';
declare module '@exprtlabs/golem/model' {
  interface GeneratedModel<Wire, Fields> { readonly handwrittenMarker: Wire | Fields }
}
export {};
`);
  assert.throws(
    () => generate({ root, profile: { validation: false } }),
    /item\.model\.generated\.ts\(\d+,\d+\): error TS2420: Class 'TItemBaseModel' incorrectly implements interface 'GeneratedModel/,
  );
});

test('configured suffixes select the model sources and name each generated file after its source', (t: TestContext) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-generate-suffixes-', linkTypescript: true });
  writeModelSources(sourceRoot, {
    'order.entity.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TOrder = IModel<{ id: string }>;`,
    'order.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TIgnored = IModel<{ id: string }>;`,
  });
  // A variable keeps the test free of the context type, which names the suffixes only once they exist.
  const context = { root, suffixes: ['.entity.ts'], profile: { validation: false } };
  const result = generate(context);
  const paths = result.artifacts.map(artifact => artifact.path);
  assert.ok(paths.includes(path.join(sourceRoot, 'order.entity.generated.ts')), 'the companion keeps the whole source name');
  assert.equal(paths.some(filename => filename.endsWith('order.model.generated.ts')), false, 'a file without a configured suffix is not a source');
  assert.ok(result.watchInputs.includes(path.join(sourceRoot, 'order.entity.ts')));
});

test('an explicit source may have any TypeScript file name, whatever the suffixes', (t: TestContext) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-generate-any-name-', linkTypescript: true });
  writeModelSources(sourceRoot, { 'anything.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TAnything = IModel<{ id: string }>;` });
  const result = generate({ root, sources: [path.join(sourceRoot, 'anything.ts')], profile: { validation: false } });
  assert.ok(result.artifacts.some(artifact => artifact.path === path.join(sourceRoot, 'anything.generated.ts')));
});

test('generated companions of .mts models import sibling companions with .mjs specifiers and type-check', async (t: TestContext) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-generate-mts-', linkTypescript: true, include: ['src/**/*.mts'] });
  writeModelSources(sourceRoot, {
    'line.entity.mts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TLine = IModel<{ sku: string }>;`,
    'order.entity.mts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TLine } from './line.entity.mjs';
export type TOrder = IModel<{ lines: TLine[] }>;`,
  });
  // A variable keeps the test free of the context type, which names the suffixes only once they exist.
  const context = { root, suffixes: ['.entity.mts'], profile: { validation: false } };
  const result = generate(context);
  const order = result.artifacts.find(artifact => artifact.path === path.join(sourceRoot, 'order.entity.generated.mts'));
  assert.ok(order, 'the companion of an .mts source is a .generated.mts file');

  // Built and run, the order companion loads the line companion through its .mjs specifier.
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nmodel:\n  suffixes: [.entity.mts]\n');
  await buildModelProject(root);
  const { TOrderBaseModel } = await import(pathToFileURL(path.join(root, 'build/order.entity.generated.mjs')).href);
  const { TLineBaseModel } = await import(pathToFileURL(path.join(root, 'build/line.entity.generated.mjs')).href);
  const decoded = modelCodec(TOrderBaseModel).fromWireFormat({ lines: [{ sku: 'a' }] });
  assert.ok(decoded.lines[0] instanceof TLineBaseModel);
  assert.deepEqual(modelCodec(decoded).toWireFormat(decoded), { lines: [{ sku: 'a' }] });
});

test('the codec keys go under .golem/ of the golem.yaml directory when the job has one, named from the tsconfig directory', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, {
    'account.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TAccount = IModel<{ id: string }>;`,
  });
  const directory = path.join(root, 'config');
  const result = generate({ root, directory, profile: { validation: false } });
  const keys = result.artifacts.find((artifact) => artifact.path === path.join(directory, '.golem/codec-keys.json'));
  assert.ok(keys, 'the codec key file lies under the configuration directory');
  const table = JSON.parse(keys.content) as { version: number; keys: Record<string, string> };
  assert.equal(table.version, 1);
  assert.deepEqual(Object.keys(table.keys), ['src/account.model.ts#TAccount']);
});

/** A fixture of two files: `TMoney` (a tagged field, an `unknown` field, a Date field) and `TPayment`, which nests it. */
function nestedPaymentProject(t: TestContext) {
  // An import that a companion does not use fails the strict unused compile of a build.
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-generator-', name: 'model-generator', compilerOptions: { noUnusedLocals: true } });
  writeModelSources(sourceRoot, {
    'money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TMoney = IObject<{ currency: string & MinLength<3>; note: unknown; at: Date }, { allowAny: true }>;
`,
    'payment.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TMoney } from './money.model.js';
export type TPayment = IModel<{ id: string; total: TMoney }>;
`,
  });
  return { root, sourceRoot };
}

const NESTED_PAYMENT_WIRE = { id: 'p1', total: { currency: 'USD', note: 1, at: '2024-01-01T00:00:00.000Z' } };

/** A workspace folder with `@exprtlabs/golem` linked, for projects that include a folder outside their own root. */
function sharedWorkspace(t: TestContext): string {
  const outer = createFixtureProject(t, 'golem-shared-depth-');
  linkProjectPackages(outer, { '@exprtlabs/golem': path.join(workspace, 'packages/golem') });
  return outer;
}

/** An app at `relative` under `outer` whose tsconfig includes `include`, which names a shared folder. */
function appProject(outer: string, relative: string, include: string): string {
  const root = path.join(outer, relative);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: path.basename(root), private: true, type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true },
    include: ['src/**/*.ts', include],
  }));
  return root;
}

const rulesSource = tsSource`export function isEven(value: number): boolean | string { return value % 2 === 0 || 'must be even'; }
`;

test('one package installed at two paths and used by models of one job is one binding', (t: TestContext) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-two-copies-', name: 'two-copies', linkTypescript: true });
  const exports = { './codecs': { types: './dist/codecs.d.ts', import: './dist/codecs.js' }, './tags': { types: './dist/tags.d.ts', import: './dist/tags.js' } };
  // Two physical copies of one package: one beside the app, one under a folder that has its own node_modules.
  writeCodecPackage(path.join(root, 'node_modules/@fixture/pg'), { name: '@fixture/pg', exports, files: COUNT_DIST_FILES });
  writeCodecPackage(path.join(sourceRoot, 'two/node_modules/@fixture/pg'), { name: '@fixture/pg', exports, files: COUNT_DIST_FILES });
  // The compiler reads two copies of one name and version as one file; another version keeps the copies apart.
  const copyManifest = path.join(sourceRoot, 'two/node_modules/@fixture/pg/package.json');
  fs.writeFileSync(copyManifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(copyManifest, 'utf8')) as object, version: '0.0.1' }));
  const model = (name: string): string => taggedModelSource({ name, imports: tsSource`import type { PkgCount } from '@fixture/pg/tags';`, fields: tsSource`count: PkgCount` }).text;
  writeModelSources(sourceRoot, { 'a.model.ts': model('A'), 'two/b.model.ts': model('B') });
  const result = generate({ root, profile: { validation: true } });
  for (const name of ['a.model.generated.ts', 'two/b.model.generated.ts']) {
    const generated = result.artifacts.find(artifact => artifact.path.endsWith(name))?.content ?? '';
    assert.equal([...generated.matchAll(/^import \{ encodeCount as __golemSerialize0Source, decodeCount as __golemDeserialize0Source \} from "@fixture\/pg\/codecs";$/gm)].length, 1, `${name} binds the package import, not a copy`);
  }
});

test('with validation on, a model validates and the nested model that turns validation off stays open', async (t: TestContext) => {
  // protects: a validating model compiles the codecs it references: the nested Date child, whose model and wire schemas differ, is left open when it turns validation off
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, {
    'child.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { Minimum } from '@exprtlabs/golem/tags';
export type TChild = IObject<{ count: number & Minimum<10>; at: Date }, { validation: false }>;
`,
    'parent.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import type { TChild } from './child.model.js';
export type TParent = IModel<{ name: string & MinLength<3>; child: TChild }>;
`,
  });
  // verify-open-child.mjs runs the validators of the parent and shows that the nested model with validation off stays open.
  writeModelGolemYaml(root, { validation: true });
  await buildModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-generator/verify-open-child.mjs', 'verify-open-child.mjs');
  await command(root, process.execPath, [verifier, generatedCodecIdFromRoot(root, 'TParent'), generatedCodecIdFromRoot(root, 'TChild')]);
});

test('a companion imports only the validators of its own models and the companions its source imports', async (t: TestContext) => {
  const { root } = nestedPaymentProject(t);
  // The strict unused compile of the build fails on a name the companion imports and does not use, and on a module it cannot find.
  writeModelGolemYaml(root, { mobx: true, validation: true });
  await buildModelProject(root);
  const spy = await spyOnBuild(root, { '@exprtlabs/golem/internal/model-runtime': ['assertAcyclicEncodeInput', 'beginEncode', 'endEncode'] });
  try {
    // The payment companion alone brings in the money companion it needs.
    const { TPaymentBaseModel, stringifyTPayment, toWireFormatTPayment } = await import(pathToFileURL(path.join(root, 'build/payment.model.generated.js')).href);
    const payment = modelCodec(TPaymentBaseModel).fromWireFormat(NESTED_PAYMENT_WIRE);
    assert.ok(payment.total.at instanceof Date, 'the nested money converts with the decoder of its own companion');
    assert.deepEqual(modelCodec(payment).toWireFormat(payment), NESTED_PAYMENT_WIRE);
    assert.equal(stringifyTPayment(payment), JSON.stringify(NESTED_PAYMENT_WIRE));
    assert.deepEqual(toWireFormatTPayment(payment), NESTED_PAYMENT_WIRE);
    // A cross-file child that is not recursive adds no cycle walk to its parent.
    assert.deepEqual(spy.calls, []);
  } finally { spy.stop(); }
});

/** A model file with no alias: it extends the class of a companion that the project's own SDK generated. */
const BASE_CLASS_MODEL = tsSource`import { TPaymentBase } from './payment.model.generated.js';
export class Payment extends TPaymentBase {}
`;
const SDK_COMPANION = 'export class TPaymentBase {}\n';
const ORDER_MODEL = tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TOrder = IModel<{ id: string }>;
`;

test('a discovered model file without an IModel or IObject alias is skipped, and the companion beside it is left alone', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, {
    'order.model.ts': ORDER_MODEL,
    'payment.model.ts': BASE_CLASS_MODEL,
    'payment.model.generated.ts': SDK_COMPANION,
  });

  const { artifacts } = generate({ root, profile: { validation: true } });
  const companions = generatedModelPaths(artifacts);
  assert.deepEqual(companions, [path.join(sourceRoot, 'order.model.generated.ts')]);
});

test('a job whose discovered model files all lack an alias generates nothing', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, { 'payment.model.ts': BASE_CLASS_MODEL, 'payment.model.generated.ts': SDK_COMPANION });

  const result = generate({ root, profile: { validation: true } });
  assert.deepEqual(result.artifacts, []);
});

test('a model file that models.sources names must hold an IModel or IObject alias', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, { 'payment.model.ts': BASE_CLASS_MODEL, 'payment.model.generated.ts': SDK_COMPANION });

  assert.throws(
    () => generate({ root, sources: [path.join(sourceRoot, 'payment.model.ts')], profile: { validation: true } }),
    { message: 'No exported IModel<...> type aliases were found.' },
  );
});

/** A shared folder `outer/shared` with a golem.yaml of its own, and an app that includes it and has a model of its own. */
function sharedFolderWithConfig(t: TestContext, configuration: string): { readonly root: string; readonly sharedFolder: string } {
  const outer = sharedWorkspace(t);
  const sharedFolder = path.join(outer, 'shared');
  fs.mkdirSync(sharedFolder, { recursive: true });
  fs.writeFileSync(path.join(sharedFolder, 'package.json'), JSON.stringify({ name: '@acme/shared', private: true, type: 'module' }));
  fs.writeFileSync(path.join(sharedFolder, 'golem.yaml'), configuration);
  fs.writeFileSync(path.join(sharedFolder, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true },
    include: ['src/**/*.ts'],
  }));
  writeModelSources(sharedFolder, {
    'src/money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TMoney = IObject<{ currency: string }>;
`,
  });
  const root = appProject(outer, 'a', '../shared/**/*.ts');
  writeModelSources(path.join(root, 'src'), { 'order.model.ts': ORDER_MODEL });
  return { root, sharedFolder };
}

test('a model file of a folder outside the root with its own golem.yaml is generated by each app in its own models.output, and by that job in its own folder', (t: TestContext) => {
  // protects: R-20 each app writes the companion of a shared model; golem writes nothing into the shared folder
  const { root, sharedFolder } = sharedFolderWithConfig(t, 'version: 1\nmodel: {}\n');
  const profile = { validation: true };

  const app = generate({ root, profile });
  assert.deepEqual(
    generatedModelPaths(app.artifacts),
    [path.join(root, 'src/order.model.generated.ts'), path.join(root, 'src/generated/models/@acme/shared/src/money.model.generated.ts')],
  );

  const own = generate({ root: sharedFolder, profile });
  assert.deepEqual(
    generatedModelPaths(own.artifacts),
    [path.join(sharedFolder, 'src/money.model.generated.ts')],
  );
});

test('a model source that does not exist is named relative to the working directory', (t: TestContext) => {
  // protects: T-450 a message names a local file relative to the working directory
  const { root, sourceRoot } = project(t);
  const missing = path.join(sourceRoot, 'missing.model.ts');

  assert.throws(
    () => generate({ root, sources: [missing], profile: { validation: true } }),
    (error: unknown) => error instanceof Error && error.message.match(/^Model source does not exist: (.*)$/)?.[1] === path.relative(process.cwd(), missing),
  );
});

test('a golem.yaml with a models job below the root of another models job stops generation with RUNM1077 naming it', (t: TestContext) => {
  // protects: R-20 nested models job is an error
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, {
    'order.model.ts': ORDER_MODEL,
    'lib/golem.yaml': 'version: 1\nmodel: {}\n',
    'lib/money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TMoney = IObject<{ currency: string }>;
`,
  });

  assert.throws(
    () => generate({ root, profile: { validation: true } }),
    { message: `RUNM1077: ${path.relative(process.cwd(), path.join(sourceRoot, 'lib/golem.yaml'))} declares a model block below the golem.yaml folder ${path.relative(process.cwd(), root)}, where the model block of ${path.relative(process.cwd(), path.join(root, 'golem.yaml'))} already generates the same model files. Two blocks would write one generated file. Remove the model block from its golem.yaml, or move the folder out of the golem.yaml folder.` },
  );
});

test('a TValidation function of a folder outside the root is imported by a path that does not depend on the location', (t: TestContext) => {
  // protects: T-640 the same sources give the same generated files at any location
  // The files are kept in a repository, so the import of the function and every other path in them follow the layout, never the machine path.
  const generateAtNewLocation = (): ReadonlyMap<string, string> => {
    const outer = sharedWorkspace(t);
    writeModelSources(path.join(outer, 'shared'), {
      'package.json': JSON.stringify({ private: true, type: 'module' }),
      'rules.ts': rulesSource,
    });
    const root = appProject(outer, 'a', '../shared/**/*.ts');
    writeModelSources(path.join(root, 'src'), {
      'order.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { isEven } from '../../shared/rules.js';
export type TOrder = IModel<{ count: number & TValidation<typeof isEven> }>;
`,
    });
    const { artifacts } = generate({ root, profile: { validation: true } });
    return new Map(artifacts.map(artifact => [path.relative(root, artifact.path), artifact.content]));
  };
  const first = generateAtNewLocation();
  assert.match(first.get('src/generated/models/models.validators.generated.ts') ?? '', /import \{ isEven as \w+ \} from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/rules\.js"/, 'the validators file imports the function by its path from the generated file to the shared folder');
  assert.deepEqual(generateAtNewLocation(), first);
});

test('a golem.yaml above the golem.yaml of the job is not another job: the sources of the app are generated', (t: TestContext) => {
  const outer = sharedWorkspace(t);
  fs.writeFileSync(path.join(outer, 'package.json'), JSON.stringify({ name: 'repository', private: true, type: 'module' }));
  fs.writeFileSync(path.join(outer, 'golem.yaml'), 'version: 1\nmodel: {}\n');
  const root = path.join(outer, 'apps/a');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true },
    include: ['src/**/*.ts'],
  }));
  writeModelSources(path.join(root, 'src'), { 'order.model.ts': ORDER_MODEL });

  const { artifacts } = generate({ root, profile: { validation: true } });
  assert.deepEqual(
    generatedModelPaths(artifacts),
    [path.join(root, 'src/order.model.generated.ts')],
  );
});

/** An installed package `@acme/money` whose declaration file declares `TPkgMoney` as an IObject alias and `TPlain` as a plain type. */
function installPackageWithModel(outer: string): string {
  const packageRoot = path.join(outer, 'node_modules/@acme/money');
  writeModelSources(packageRoot, {
    'package.json': JSON.stringify({ name: '@acme/money', version: '1.0.0', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } }),
    'index.d.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TPkgMoney = IObject<{ currency: string }>;
export type TPlain = { currency: string };
`,
  });
  return fs.realpathSync(path.join(packageRoot, 'index.d.ts'));
}

/** Each shape of an app model that reaches the package's model, with where the diagnostic points: the type of the field. */
const PACKAGE_MODEL_FIELDS = {
  'a field that nests the model': { position: '3:38', source: tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TPkgMoney } from '@acme/money';
export type TOrder = IModel<{ total: TPkgMoney }>;
` },
  'a field that nests an alias of the model': { position: '4:38', source: tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TPkgMoney } from '@acme/money';
type TMoney = TPkgMoney;
export type TOrder = IModel<{ total: TMoney }>;
` },
  'an IObject that nests the model': { position: '3:39', source: tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TPkgMoney } from '@acme/money';
export type TOrder = IObject<{ total: TPkgMoney }>;
` },
};

for (const [shape, { position, source }] of Object.entries(PACKAGE_MODEL_FIELDS)) {
  test(`${shape} that an installed package declares in a file with no model suffix fails with the model and the suffix`, (t: TestContext) => {
    // protects: R-20 RUNM1074 keeps one reason: the model file has no model suffix
    const outer = sharedWorkspace(t);
    const declaration = installPackageWithModel(outer);
    const root = appProject(outer, 'a', '../shared/**/*.ts');
    writeModelSources(path.join(root, 'src'), { 'order.model.ts': source });

    assert.throws(
      () => generate({ root, profile: { validation: true } }),
      { code: 'RUNM1074', message: `${path.relative(process.cwd(), path.join(root, 'src/order.model.ts'))}:${position} RUNM1074: ${path.relative(process.cwd(), declaration)}#TPkgMoney is declared in a file whose name has no model suffix. Golem reads a model from a file whose name ends in .model.ts or .models.ts. Move the model into such a file.` },
    );
  });
}

test('a plain type from an installed package or a shared folder is a field of a model', (t: TestContext) => {
  const outer = sharedWorkspace(t);
  installPackageWithModel(outer);
  writeModelSources(path.join(outer, 'shared'), {
    'package.json': JSON.stringify({ name: '@acme/shared', private: true, type: 'module' }),
    'plain.ts': 'export type TShared = { amount: number };\n',
  });
  const root = appProject(outer, 'a', '../shared/**/*.ts');
  writeModelSources(path.join(root, 'src'), {
    'order.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TPlain } from '@acme/money';
import type { TShared } from '../../shared/plain.js';
export type TOrder = IObject<{ total: TPlain; shared: TShared }>;
`,
  });

  const { artifacts } = generate({ root, profile: { validation: true } });
  assert.deepEqual(generatedModelPaths(artifacts), [path.join(root, 'src/order.model.generated.ts')]);
});

/** The shared folder `outer/shared` with a model file whose `TMoney` is an IObject alias; returns the real path of the file. */
function sharedMoneyModel(outer: string): string {
  writeModelSources(path.join(outer, 'shared'), {
    'package.json': JSON.stringify({ name: '@acme/shared', private: true, type: 'module' }),
    'money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TMoney = IObject<{ currency: string }>;
`,
  });
  return fs.realpathSync(path.join(outer, 'shared/money.model.ts'));
}

test('models.root reached through a folder link still owns its model files', (t: TestContext) => {
  const outer = sharedWorkspace(t);
  const real = appProject(outer, 'real-app', 'src/**/*.ts');
  writeModelSources(path.join(real, 'src'), { 'order.model.ts': ORDER_MODEL });
  const root = path.join(outer, 'app-link');
  fs.symlinkSync(real, root, 'dir');

  const { artifacts } = generate({ root, profile: { validation: true } });
  assert.deepEqual(
    generatedModelPaths(artifacts),
    [path.join(root, 'src/order.model.generated.ts')],
  );
});

test('no generated file is written outside the golem.yaml folder', (t: TestContext) => {
  const outer = sharedWorkspace(t);
  sharedMoneyModel(outer);
  writeModelSources(path.join(outer, 'shared'), { 'plain.ts': 'export type TShared = { amount: number };\n' });
  const root = appProject(outer, 'a', '../shared/**/*.ts');
  writeModelSources(path.join(root, 'src'), {
    'order.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TShared } from '../../shared/plain.js';
export type TOrder = IObject<{ shared: TShared }>;
`,
  });

  const { artifacts } = generate({ root, profile: { validation: true } });
  writeGeneratedArtifacts(artifacts);
  assert.deepEqual(fs.readdirSync(path.join(outer, 'shared')).sort(), ['money.model.ts', 'package.json', 'plain.ts']);
  assert.deepEqual(artifacts.map(artifact => artifact.path).filter(file => !file.startsWith(`${root}${path.sep}`)), []);
});

test('a sources entry outside the models root stops generation with RUNM1075 naming the entry and the root', (t: TestContext) => {
  const outer = sharedWorkspace(t);
  const money = sharedMoneyModel(outer);
  const root = appProject(outer, 'a', 'src/**/*.ts');
  writeModelSources(path.join(root, 'src'), { 'order.model.ts': ORDER_MODEL });

  assert.throws(
    () => generate({ root, sources: [path.join(root, 'src/order.model.ts'), money], profile: { validation: true } }),
    { message: `RUNM1075: model.sources entry ${path.relative(process.cwd(), money)} is outside the golem.yaml folder ${path.relative(process.cwd(), root)}. The model block generates only files inside that folder.` },
  );
});

test('a sources entry that links to a file outside the models root stops generation with RUNM1075 and its real path', (t: TestContext) => {
  const outer = sharedWorkspace(t);
  const money = sharedMoneyModel(outer);
  const root = appProject(outer, 'a', 'src/**/*.ts');
  fs.symlinkSync(money, path.join(root, 'src/money.model.ts'));

  assert.throws(
    () => generate({ root, sources: [path.join(root, 'src/money.model.ts')], profile: { validation: true } }),
    { message: `RUNM1075: model.sources entry ${path.relative(process.cwd(), money)} is outside the golem.yaml folder ${path.relative(process.cwd(), root)}. The model block generates only files inside that folder.` },
  );
});

test('a sources entry inside a nested golem.yaml with a models job stops generation with RUNM1077', (t: TestContext) => {
  // protects: R-20 nested models job is an error, also for a listed sources entry
  const outer = sharedWorkspace(t);
  const root = appProject(outer, 'a', 'src/**/*.ts');
  writeModelSources(path.join(root, 'src'), {
    'lib/golem.yaml': 'version: 1\nmodel: {}\n',
    'lib/money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TMoney = IObject<{ currency: string }>;
`,
  });

  assert.throws(
    () => generate({ root, sources: [path.join(root, 'src/lib/money.model.ts')], profile: { validation: true } }),
    (error: unknown) => error instanceof Error
      && error.message.startsWith(`RUNM1077: ${path.relative(process.cwd(), path.join(fs.realpathSync(root), 'src/lib/golem.yaml'))} declares a model block below the golem.yaml folder ${path.relative(process.cwd(), fs.realpathSync(root))}, where `),
  );
});


test('a validation function exported under the form of a generated local stops generation with RUNM1088 at its use', (t: TestContext) => {
  // protects: T-643 R-59 a user name with the form of a local ($v0) is a diagnostic with file and line, never a raw TypeError
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-local-form-', name: 'local-form', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'rules.ts': tsSource`export function $v0(value: number): boolean | string { return value % 2 === 0 || 'must be even'; }
`,
    'a.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { $v0 } from './rules.js';
export type TA = IModel<{ n: number & TValidation<typeof $v0> }>;
`,
  });
  assert.throws(
    () => generate({ root, profile: { validation: true } }),
    (error: unknown) => error instanceof Error && error.message.endsWith(
      'a.model.ts:4:51 RUNM1088: The validation function is named "$v0", which has the form of a local of generated code (a $, one lowercase letter and digits). Generated code cannot import it under that name. Rename it.',
    ),
  );
});

test('a model class named in the form of a generated local stops generation with RUNM1088 where another model uses it', (t: TestContext) => {
  // protects: T-643 R-59 an imported class named $b is a diagnostic with file and line, never a raw TypeError
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-local-form-', name: 'local-form', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'b.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import { TBBaseModel } from './b.model.generated.js';
export type TB = IModel<{ id: string }>;
export class $b extends TBBaseModel {}
`,
    'a.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import { $b } from './b.model.js';
export type TA = IModel<{ b: $b }>;
`,
  });
  assert.throws(
    () => generate({ root, profile: { validation: true } }),
    (error: unknown) => error instanceof Error && error.message.endsWith(
      'b.model.ts:4:14 RUNM1088: The class is named "$b", which has the form of a local of generated code (a $, one lowercase letter and digits). Generated code cannot import it under that name. Rename it.',
    ),
  );
});

test('serde functions exported under the form of a generated local are imported under an alias and generate', (t: TestContext) => {
  // protects: T-643 R-59 only a name that generated code binds is refused; an aliased import binds the alias
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-local-form-', name: 'local-form', linkWorkspaceNodeModules: true });
  writeModelSources(sourceRoot, {
    'codecs.ts': tsSource`export function $e(value: bigint): string { return value.toString(); }
export function $d(wire: string): bigint { return BigInt(wire); }
`,
    'a.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TSerde } from '@exprtlabs/golem/tags';
import { $d, $e } from './codecs.js';
export type TA = IModel<{ big: bigint & TSerde<typeof $e, typeof $d> }>;
`,
  });
  const source = generate({ root, profile: { validation: false } }).artifacts.find(artifact => artifact.path.endsWith('a.model.generated.ts'))?.content ?? '';
  assert.match(source, /import \{ \$e as __golemSerialize0Source, \$d as __golemDeserialize0Source \} from "\.\/codecs\.js";/);
});

/** A project whose golem.yaml (in `app`) holds `yaml`, with golem-model installed as a dependency and `@fixture/shop`, the scripted plan entry, as the block `shop`. */
function configProject(t: TestContext, yaml: string): { root: string; app: string; filename: string } {
  const root = createFixtureProject(t, 'golem-model-config-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@exprtlabs/golem-model': '1.0.0', '@fixture/shop': '1.0.0' } }));
  linkProjectPackages(root, { '@exprtlabs/golem-model': path.join(workspace, 'packages/golem-model') });
  const shop = path.join(root, 'node_modules/@fixture/shop');
  fs.mkdirSync(path.dirname(shop), { recursive: true });
  copyFixture(shop, 'config/scripted-plan');
  const template = JSON.parse(fs.readFileSync(path.join(shop, 'package.json'), 'utf8')) as { golem: object };
  fs.writeFileSync(path.join(shop, 'package.json'), JSON.stringify({ ...template, name: '@fixture/shop', golem: { ...template.golem, block: 'shop' } }));
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'tsconfig.json'), '{}');
  const filename = path.join(app, 'golem.yaml');
  fs.writeFileSync(filename, `version: 1\n${yaml}`);
  return { root, app, filename };
}

const modelJobOf = async (filename: string) => {
  const config = await resolveConfig(filename);
  const job = config.jobs.find(candidate => candidate.block === 'model');
  assert.ok(job, 'the config holds the models job');
  return { config, job };
};

test('an empty model block scans from the golem.yaml folder, writes the default output and provides both contracts', async (t: TestContext) => {
  // protects: R4 the models job scans from the golem.yaml folder; page "Packages": golem-model provides ModelBoundary and CodecsHost, owns its model folder (an exclusive output the app imports) and reads the program
  const { app, filename } = configProject(t, 'model:\n');
  const { config, job } = await modelJobOf(filename);
  const output = path.join(app, 'src/generated/models');
  assert.equal(job.id, 'model');
  assert.equal(job.package, '@exprtlabs/golem-model');
  assert.deepEqual(job.facts, {
    id: 'model', outputs: [{ path: output, kind: 'folder', importedByApp: true }], ownedRoots: [app], inputFiles: [], inputFolders: [], readsProgram: true,
    provides: ['ModelBoundary', 'CodecsHost'], needs: [], hooks: ['model.validatorEnhancer', 'model.codecData'], watch: [{ suffixes: ['.model.ts', '.models.ts'] }],
  });
  assert.deepEqual(job.options, { root: app, directory: app, output, tsconfig: path.join(app, 'tsconfig.json'), profile: config.profile });
  assert.deepEqual(config.contracts, { ModelBoundary: { root: app, directory: app, output, suffixes: ['.model.ts', '.models.ts'] }, CodecsHost: { modelsOutput: output, configDirectory: app } });
});

test('a model source inside the output folder of the job loads, and the job reads no file it writes into', async (t: TestContext) => {
  // protects: T-786 sources in the output folder are not input files, so the job does not "write what it reads"
  const { app, filename } = configProject(t, 'model:\n  output: src/models\n  sources: [src/models/a.model.ts, src/b.model.ts]\n');
  fs.mkdirSync(path.join(app, 'src/models'), { recursive: true });
  fs.writeFileSync(path.join(app, 'src/models/a.model.ts'), 'export {};\n');
  fs.writeFileSync(path.join(app, 'src/b.model.ts'), 'export {};\n');

  const { job } = await modelJobOf(filename);

  assert.deepEqual(job.facts.inputFiles, [path.join(app, 'src/b.model.ts')]);
});

test('model sources, suffixes and output reach the options and the boundary; the owned roots run from the source folders to the root', async (t: TestContext) => {
  // protects: page "What a job declares": the model folder is an exclusive output and the owned roots run narrow to wide, so a file is recorded under its narrowest owner; the boundary carries the suffixes the rewrite reads
  const { app, filename } = configProject(t, 'exact: false\nmodel:\n  output: gen/models\n  suffixes: [.entity.ts, .record.mts]\n  sources: [a/b/x.entity.ts, a/y.record.mts]\n');
  const { job, config } = await modelJobOf(filename);
  assert.deepEqual(job.facts.outputs, [{ path: path.join(app, 'gen/models'), kind: 'folder', importedByApp: true }]);
  assert.deepEqual(job.facts.ownedRoots, [path.join(app, 'a/b'), path.join(app, 'a'), app]);
  // A job with a list of sources reads those files and no others: nothing is watched for new ones.
  assert.deepEqual(job.facts.watch, []);
  assert.deepEqual(job.options, {
    root: app, directory: app, output: path.join(app, 'gen/models'), tsconfig: path.join(app, 'tsconfig.json'), profile: config.profile, exact: false,
    sources: [path.join(app, 'a/b/x.entity.ts'), path.join(app, 'a/y.record.mts')], suffixes: ['.entity.ts', '.record.mts'],
  });
  assert.deepEqual(config.contracts.ModelBoundary, { root: app, directory: app, output: path.join(app, 'gen/models'), suffixes: ['.entity.ts', '.record.mts'] });
});

const MODEL_SUFFIX_CASES: readonly (readonly [string, string])[] = [
  ['[]', 'model.suffixes must be a nonempty array.'],
  ['.model.ts', 'model.suffixes must be a nonempty array.'],
  ['[""]', 'model.suffixes[0] must be a string that starts with "." and ends in .ts, .mts or .cts.'],
  ['[.model.ts, model.ts]', 'model.suffixes[1] must be a string that starts with "." and ends in .ts, .mts or .cts.'],
  ['[.model.js]', 'model.suffixes[0] must be a string that starts with "." and ends in .ts, .mts or .cts.'],
  ['[.model.ts, 3]', 'model.suffixes[1] must be a string that starts with "." and ends in .ts, .mts or .cts.'],
  ['[.d.ts]', 'model.suffixes[0] must not end in .d.ts, .d.mts or .d.cts: a declaration file cannot be a source.'],
  ['[.model.generated.ts]', 'model.suffixes[0] must not end in .generated.ts, .generated.mts or .generated.cts: golem writes those files.'],
  ['[.model.generated.cts]', 'model.suffixes[0] must not end in .generated.ts, .generated.mts or .generated.cts: golem writes those files.'],
  ['[.model.ts, .models.ts, .model.ts]', 'model.suffixes lists .model.ts twice.'],
];
for (const [suffixes, message] of MODEL_SUFFIX_CASES) {
  test(`model.suffixes ${suffixes} stops loading with a message that names the entry`, async (t: TestContext) => {
    // protects: a suffix that is empty, malformed, repeated, a declaration or a generated file would make golem read its own output or nothing
    const { filename } = configProject(t, `model:\n  suffixes: ${suffixes}\n`);
    await assert.rejects(() => resolveConfig(filename), { message });
  });
}

const MODEL_BLOCK_CASES: readonly (readonly [string, string])[] = [
  ['model: [a]', 'model must be an object.'],
  ['model:\n  sourcs: [a.model.ts]', 'Unknown model key: sourcs.'],
  ['model:\n  output: ""', 'model.output must be a nonempty string.'],
  ['model:\n  output: tsconfig.json', 'model.output must be a directory.'],
  ['model:\n  sources: []', 'model.sources must be a nonempty array.'],
  ['model:\n  sources: [a.model.ts, ./a.model.ts]', 'Duplicate model sources.'],
];
for (const [block, message] of MODEL_BLOCK_CASES) {
  test(`the model block ${JSON.stringify(block)} stops loading with ${JSON.stringify(message)}`, async (t: TestContext) => {
    // protects: the block is validated whole at config time, so a misspelled key or a bad value never reaches a generator
    const { filename } = configProject(t, `${block}\n`);
    await assert.rejects(() => resolveConfig(filename), { message });
  });
}

for (const [name, link] of [['a source outside the root', false], ['a source that links to a file outside the root', true]] as const) {
  test(`${name} stops loading with RUNM1075 naming the real path and the root`, async (t: TestContext) => {
    // protects: the model block generates only files inside the golem.yaml folder (RUNM1075), and a link shows as the file it points to
    const { root, app, filename } = configProject(t, `model:\n  sources: [${link ? 'src/money.model.ts' : '../shared/money.model.ts'}]\n`);
    fs.mkdirSync(path.join(root, 'shared'));
    fs.writeFileSync(path.join(root, 'shared/money.model.ts'), 'export {};\n');
    if (link) fs.symlinkSync('../../shared/money.model.ts', path.join(app, 'src/money.model.ts'));
    await assert.rejects(() => resolveConfig(filename), {
      message: `RUNM1075: model.sources entry ${path.relative(process.cwd(), path.join(root, 'shared/money.model.ts'))} is outside the golem.yaml folder ${path.relative(process.cwd(), app)}. The model block generates only files inside that folder.`,
    });
  });
}

for (const [name, output, resolved] of [
  ['a model output', '../outside', 'outside'],
  ['a model output behind a link to a folder', 'linked/models', 'outside/models'],
] as const) {
  test(`${name} outside the tsconfig directory stops loading and writes nothing`, async (t: TestContext) => {
    // protects: F-42 the models output stays inside the tsconfig directory (T-182)
    const { root, app, filename } = configProject(t, `model:\n  output: ${output}\n`);
    fs.mkdirSync(path.join(root, 'outside'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(app, 'linked'), 'dir');
    await assert.rejects(() => resolveConfig(filename), (error: unknown) => error instanceof JobRuleError
      && error.message === `Job model: output ${path.relative(process.cwd(), path.join(root, resolved))} is outside the tsconfig directory ${path.relative(process.cwd(), app)}. Move it inside.`);
    assert.deepEqual(fs.readdirSync(path.join(root, 'outside')), []);
  });
}

test('a model output that overlaps an SDK output stops loading', async (t: TestContext) => {
  // protects: A1 overlap rule: exclusive outputs never overlap, so the model folder and an SDK folder cannot share files (master's check of the models output)
  const { app, filename } = configProject(t, 'model:\n  output: gen\nshop:\n  jobs:\n    - { id: sdk, needs: [CodecsHost], outputs: [{ path: gen/sdk, kind: folder }] }\n');
  await assert.rejects(() => resolveConfig(filename), (error: unknown) => error instanceof JobRuleError
    && error.rule === 'overlap' && error.message === `Overlapping outputs: ${path.relative(process.cwd(), path.join(app, 'gen'))} (job model) and ${path.relative(process.cwd(), path.join(app, 'gen/sdk'))} (job sdk).`);
});

test('the models job reads the SDK folders of the jobs that need the codecs host, and so runs after them', async (t: TestContext) => {
  // protects: page "When": the SDK folders that the models job reads come from CodecsHost in the second pass, so docs, SDKs, models is the order when an SDK links them
  const shop = (jobs: string): string => `model:\nshop:\n  jobs:\n${jobs}`;
  const linked = await modelJobOf(configProject(t, shop([
    '    - { id: sdk-a, readsProgram: true, needs: [CodecsHost], outputs: [{ path: sdk/a, kind: folder }] }',
    '    - { id: sdk-b, needs: [CodecsHost], outputs: [{ path: sdk/b, kind: folder }] }',
    '    - { id: docs, readsProgram: true, outputs: [{ path: api.yaml }] }',
  ].join('\n') + '\n')).filename);
  const app = path.dirname(linked.config.configFile);
  assert.deepEqual(linked.job.facts.inputFolders, [path.join(app, 'sdk/a'), path.join(app, 'sdk/b')]);
  assert.deepEqual(Reflect.get(linked.job.options as object, 'sdkOutputs'), [path.join(app, 'sdk/a'), path.join(app, 'sdk/b')]);
  assert.deepEqual(linked.config.jobs.map(job => job.id).filter(id => id !== 'sdk-b'), ['sdk-a', 'model', 'docs']);

  const unlinked = await modelJobOf(configProject(t, shop('    - { id: docs, outputs: [{ path: api.yaml }] }\n')).filename);
  assert.deepEqual(unlinked.job.facts.inputFolders, []);
  assert.equal('sdkOutputs' in (unlinked.job.options as object), false);
});

test('the plan entry of golem-model loads without TypeScript, yaml or the generator', async () => {
  // protects: T-767 anchor: the plan entry imports no TypeScript, no generator code and no yaml, because core loads it at config time
  const script = [
    "const { registerHooks, createRequire } = require('node:module');",
    'const urls = [];',
    'registerHooks({ resolve(specifier, context, next) { const resolved = next(specifier, context); urls.push(resolved.url); return resolved; } });',
    'createRequire(process.cwd() + "/")(process.argv[1]);',
    'console.log(JSON.stringify(urls));',
  ].join('\n');
  const { stdout } = await command(workspace, process.execPath, ['-e', script, path.join(workspace, 'packages/golem-model/dist/plan.js')]);
  const urls = JSON.parse(stdout) as string[];
  assert.ok(urls.some(url => url.endsWith('/golem/dist/tooling/plan-support.js')), 'the hook sees the plan entry load its core helpers');
  assert.deepEqual(urls.filter(url => /\/(typescript|yaml)\/|generator(-core)?\.js$/.test(url)), []);
});
