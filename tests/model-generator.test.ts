import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { command, workspace } from './support/process.js';
import { spyOnBuild } from './support/build-spy.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { marker } from '#golem/outputs';
import { decodeGeneratedModel, encodeGeneratedModel } from '@exprtlabs/golem/conversion';
import { LibError, LibErrorKind } from '@exprtlabs/golem/errors';
import { requireObjectCodec } from '@exprtlabs/golem/serde';
import { getValidator } from '@exprtlabs/golem/validation';

import { copyFixture, copyFixtureFile, createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from './fixture-project.js';
import { accountModelWithField, accountModelWithMissingImport } from './fixture-templates/models/model-generator.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';
import { taggedModelSource } from './fixture-templates/models/model-tags.js';
import { COUNT_DIST_FILES, writeCodecPackage } from './fixture-templates/models/codec-package.js';
import { tsSource } from './source-template.js';

import {
  apiVersion,
  discoverModelSources,
  generate,
} from '#model/generator';

function project(t: TestContext) {
  return createModelProject(t, { prefix: 'golem-model-generator-', name: 'model-generator' });
}

function profileCases(): readonly [{ mobx: boolean; validation: boolean }, { mobx: boolean; validation: boolean }][] {
  return [
    [{ mobx: false, validation: false }, { mobx: false, validation: false }],
    [{ mobx: true, validation: false }, { mobx: true, validation: false }],
    [{ mobx: false, validation: true }, { mobx: false, validation: true }],
    [{ mobx: true, validation: true }, { mobx: true, validation: true }],
  ];
}

const isValidationUnavailable = (error: unknown): boolean => error instanceof LibError && error.kind === LibErrorKind.ValidationUnavailable;

test('exports API 1 and emits profile-specific model companions without writes', async (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  const source = copyFixtureFile(root, 'models/model-generator/api-profiles/src/payment.model.ts', 'src/payment.model.ts');
  const { isComputedProp } = await import('mobx');
  assert.equal(apiVersion, 1);
  for (const [profile, expected] of profileCases()) {
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
    // golem retires or replaces a file only while it recognizes its owner's marker.
    for (const artifact of result.artifacts) assert.equal(marker(artifact.content, '@exprtlabs/golem-model'), true, path.basename(artifact.path));

    // The same profile, built and run. An import or a MobX hook the profile does not use fails the strict unused compile.
    const built = createModelProject(t, { prefix: 'golem-model-generator-built-', name: 'model-generator-built', compilerOptions: { noUnusedLocals: true } });
    writeModelSources(built.sourceRoot, {
      'money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TMoney = IObject<{ currency: string & MinLength<3> }>;
`,
      'payment.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import { asGenObservable } from '@exprtlabs/golem/mobx';
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
    const payment = decodeGeneratedModel(Payment, wire);
    assert.ok(payment instanceof Payment, 'the companion registers the model for conversion');
    assert.deepEqual(encodeGeneratedModel(payment), wire);
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
  }
});

test('getValidator infers generated fields and rejects handwritten subclass fields', async (t: TestContext) => {
  const { root } = project(t);
  copyFixture(root, 'models/model-generator/validation-fields');
  writeModelGolemYaml(root, { mobx: false, validation: true });
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
  const result = generate({ root, profile: { mobx: false, validation: false } });
  assert.deepEqual(result.artifacts.map((artifact) => artifact.path).sort(), [path.join(root, '.golem/codec-keys.json'), path.join(sourceRoot, 'nested/account.models.generated.ts')], 'the run writes the companion and the codec keys under .golem/');
  assert.deepEqual(result.watchInputs, [source, path.join(root, 'tsconfig.json')]);
  assert.equal(result.watchInputs.some((filename) => filename.endsWith('.generated.ts')), false);
});

/** The fixture's SDK module with the runtime registration of a generated SDK model, and a count of the calls it receives. */
const COUNTING_SDK_MODELS = tsSource`import { registerGeneratedModel } from '@exprtlabs/golem/model';
export const calls = { decode: 0, encode: 0, stringify: 0, toWire: 0 };
export class MoneyModel {
  public currency = '';
  public constructor(values: { currency?: string } = {}) { if (values.currency !== undefined) this.currency = values.currency; }
}
registerGeneratedModel(MoneyModel, {
  fields: ['currency'],
  conversion: {
    decode: (value, constructor) => { calls.decode += 1; return Reflect.construct(constructor ?? MoneyModel, [value]) as MoneyModel; },
    encode: (model) => { calls.encode += 1; return { currency: model.currency }; },
  },
});
export function stringifyfixture_money(value: MoneyModel, _trusted?: unknown): string { calls.stringify += 1; return JSON.stringify({ currency: value.currency }); }
export function toWireFormatfixture_money(value: MoneyModel, _trusted?: unknown): object { calls.toWire += 1; return { currency: value.currency }; }
`;

test('consumes current manifests and keeps imported model identity for conversion', async (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  copyFixture(root, 'models/model-generator/manifest-identity');
  const sdkRoot = path.join(sourceRoot, 'sdk');
  const sdkTypes = path.join(sdkRoot, 'types.ts');
  const manifest = path.join(sdkRoot, 'model-manifest.json');
  const source = path.join(sourceRoot, 'aggregate.model.ts');
  writeModelSources(sdkRoot, { 'models.ts': COUNTING_SDK_MODELS });
  const result = generate({
    root,
    sources: [source],
    profile: { mobx: false, validation: false },
    manifestInputs: [manifest],
  });
  assert.equal(result.watchInputs.includes(manifest), true);
  assert.equal(result.watchInputs.includes(sdkTypes), true);

  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const sdk = await import(pathToFileURL(path.join(root, 'build/sdk/models.js')).href) as {
    readonly MoneyModel: new () => object;
    readonly calls: { decode: number; encode: number; stringify: number; toWire: number };
  };
  const { TAggregateBaseModel, stringifyTAggregate } = await import(pathToFileURL(path.join(root, 'build/aggregate.model.generated.js')).href);
  const wire = { money: { currency: 'USD' }, nested: { money: { currency: 'EUR' } } };
  const aggregate = decodeGeneratedModel(TAggregateBaseModel, wire);
  assert.ok(aggregate.money instanceof sdk.MoneyModel, 'the companion builds the SDK class of the manifest, not a copy of it');
  assert.ok(aggregate.nested.money instanceof sdk.MoneyModel);
  assert.equal(sdk.calls.decode, 2, 'each Money goes through the registered conversion of the SDK model');
  assert.deepEqual(encodeGeneratedModel(aggregate), wire);
  assert.equal(stringifyTAggregate(aggregate), JSON.stringify(wire));
  assert.equal(sdk.calls.stringify, 2, 'each Money is written by the stringify helper of the SDK');
});

test('rejects an SDK module that lacks a codec helper the companion imports', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  copyFixture(root, 'models/model-generator/manifest-identity');
  const sdkModels = path.join(sourceRoot, 'sdk/models.ts');
  // The SDK module exports the model class but not stringifyfixture_money, which the companion calls.
  fs.writeFileSync(sdkModels, 'export class MoneyModel {\n  public constructor() {}\n}\n');
  assert.throws(
    () => generate({
      root,
      sources: [path.join(sourceRoot, 'aggregate.model.ts')],
      profile: { mobx: false, validation: false },
      manifestInputs: [path.join(sourceRoot, 'sdk/model-manifest.json')],
    }),
    /generated model module \.\/models\.ts .*does not export stringifyfixture_money\b/,
  );
  assert.equal(fs.existsSync(path.join(sourceRoot, 'aggregate.model.generated.ts')), false, 'no companion is written');
});

test('a model named with a non-ASCII letter generates a companion that keeps the name', (t: TestContext) => {
  // protects: T-290 a user model name may hold any Unicode letter, as it did before Code values
  const { root, sourceRoot } = project(t);
  const source = path.join(sourceRoot, 'cafe.model.ts');
  fs.writeFileSync(source, "import type { IModel } from '@exprtlabs/golem/model';\nexport type TCafé = IModel<{ label: string }>;\n");
  const result = generate({ root, sources: [source], profile: { mobx: false, validation: true } });
  assert.ok(result.artifacts.some(artifact => artifact.content.includes('TCaféBaseModel')));
});

test('rejects missing sources and profile-mismatched manifests before emitting artifacts', (t: TestContext) => {
  // protects: T-326 an empty sources list stops with a message that names `sources`, not context.sources
  const { root, sourceRoot } = project(t);
  const manifest = path.join(root, 'external-model-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    profile: { mobx: true, validation: true, allowAny: false },
    models: [],
  }));
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: false }, manifestInputs: [manifest], sources: [] }),
    (error: Error) => /`sources` is empty.*List at least one model file in `sources`/.test(error.message) && !/context\./.test(error.message),
  );
  const source = copyFixtureFile(root, 'models/model-generator/api-profiles/src/payment.model.ts', 'src/x.model.ts');
  assert.throws(
    () => generate({ root, sources: [source], profile: { mobx: false, validation: false }, manifestInputs: [manifest] }),
    /profile mismatch/,
  );
  const profile = { mobx: false, validation: true, allowAny: false };
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
  const profile = { mobx: false, validation: true, allowAny: false };
  fs.writeFileSync(manifest, JSON.stringify({ profile, models: [] }));
  assert.throws(
    () => generate({ root, sources: [source], profile, manifestInputs: [manifest] }),
    /profile mismatch.*unknownFormats: error.*Regenerate the SDK manifest with the same profile/,
  );
  assert.equal(fs.existsSync(path.join(sourceRoot, 'x.model.generated.ts')), false);
});

test('prospective companions permit a concrete subclass field rename and still reject unrelated errors', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  const source = path.join(sourceRoot, 'account.model.ts');
  writeModelSources(sourceRoot, { 'account.model.ts': accountModelWithField({ field: 'done' }) });
  const first = generate({ root, sources: [source], profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(first.artifacts);
  writeModelSources(sourceRoot, { 'account.model.ts': accountModelWithField({ field: 'complete' }) });
  const second = generate({ root, sources: [source], profile: { mobx: false, validation: true } });
  // The validating job writes the companion, the codec keys and the generated validators.
  assert.equal(second.artifacts.length, 3);
  writeModelSources(sourceRoot, { 'account.model.ts': accountModelWithMissingImport({ field: 'complete' }) });
  assert.throws(
    () => generate({ root, sources: [source], profile: { mobx: false, validation: true } }),
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
  writeModelGolemYaml(root, { mobx: false, validation: true });
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
    generated: { module: './models.ts', export: 'MoneyModel' },
  };
  const manifest = (profile: { mobx: boolean; validation: boolean }) => ({
    profile: { ...profile, allowAny: false, unknownFormats: 'error' },
    models: [model],
  });
  fs.writeFileSync(first, JSON.stringify({ ...manifest({ mobx: false, validation: false }), manifestVersion: 99 }));
  assert.throws(
    () => generate({ root, sources: [source], profile: { mobx: false, validation: false }, manifestInputs: [first] }),
    /Outdated model manifest/,
  );
  fs.writeFileSync(first, JSON.stringify(manifest({ mobx: false, validation: false })));
  fs.writeFileSync(second, JSON.stringify(manifest({ mobx: false, validation: false })));
  assert.throws(
    () => generate({ root, sources: [source], profile: { mobx: false, validation: false }, manifestInputs: [first, second] }),
    /Duplicate model manifest id/,
  );
});

test('a job leaves the real companions of other jobs under the same tsconfig alone', (t: TestContext) => {
  // One tsconfig covers both jobs' sources. Job two's program holds job one's handwritten class, which extends the
  // base class of job one's companion; only job one's own run may replace that companion.
  const { root } = createModelProject(t, { prefix: 'golem-two-jobs-', name: 'two-jobs', rootDir: '.', include: ['jobs/*/src/**/*.ts'] });
  const profile = { mobx: false, validation: true } as const;
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
  const result = generate({ root, profile: { mobx: false, validation: true } });
  assert.ok(result.artifacts.some(artifact => artifact.path === path.join(sourceRoot, 'item.model.generated.ts')));
});

test('a solution tsconfig that starts with a byte-order mark generates with the options of the referenced project', (t: TestContext) => {
  const { root, sourceRoot } = solutionProject(t, ['./tsconfig.other.json', './tsconfig.app.json']);
  const solution = path.join(root, 'tsconfig.json');
  fs.writeFileSync(solution, `\uFEFF${fs.readFileSync(solution, 'utf8')}`);
  writeModelSources(sourceRoot, {
    'lib/ids.ts': 'export type Id = string;\n',
    'item.model.ts': taggedModelSource({ name: 'Item', imports: tsSource`import type { Id } from '@lib/ids';`, fields: tsSource`id: Id` }),
  });
  const result = generate({ root, profile: { mobx: false, validation: true } });
  assert.ok(result.artifacts.some(artifact => artifact.path === path.join(sourceRoot, 'item.model.generated.ts')));
});

test('a solution tsconfig checks a generated SDK module with the options of the referenced project', (t: TestContext) => {
  const { root, sourceRoot } = solutionProject(t, ['./tsconfig.other.json', './tsconfig.app.json']);
  copyFixture(root, 'models/model-generator/manifest-identity');
  // The SDK module reaches its exports through the app project's `paths` alias; the solution root has no paths.
  fs.mkdirSync(path.join(sourceRoot, 'lib'));
  fs.renameSync(path.join(sourceRoot, 'sdk/models.ts'), path.join(sourceRoot, 'lib/money.ts'));
  fs.writeFileSync(path.join(sourceRoot, 'sdk/models.ts'), "export * from '@lib/money';\n");
  const context = {
    root,
    sources: [path.join(sourceRoot, 'aggregate.model.ts')],
    profile: { mobx: false, validation: false },
    manifestInputs: [path.join(sourceRoot, 'sdk/model-manifest.json')],
  };
  generate(context);
  // The module is read through the alias: once it lacks the codec helper the companion calls, generation stops.
  fs.writeFileSync(path.join(sourceRoot, 'lib/money.ts'), 'export class MoneyModel {\n  public constructor() {}\n}\n');
  assert.throws(() => generate(context), /does not export stringifyfixture_money\b/);
});

test('a solution tsconfig whose references hold no model source names the solution and the source', (t: TestContext) => {
  const { root, sourceRoot } = solutionProject(t, ['./tsconfig.other.json']);
  writeModelSources(sourceRoot, { 'item.model.ts': taggedModelSource({ name: 'Item', fields: tsSource`id: string` }) });
  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
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
  const result = generate({ root: alias, profile: { mobx: false, validation: true } });
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
    () => generate({ root, profile: { mobx: false, validation: false } }),
    (error: unknown) => error instanceof Error && error.message.startsWith(`${path.relative(process.cwd(), broken)}(2,7): error TS2322: Type 'number' is not assignable to type 'string'.`),
  );
});

test('a type error in a handwritten file that is not a model source does not stop generation', (t: TestContext) => {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-generate-unrelated-error-', linkTypescript: true, compilerOptions: { declaration: false } });
  writeModelSources(sourceRoot, { 'item.model.ts': taggedModelSource({ name: 'Item', fields: tsSource`id: string` }) });
  fs.writeFileSync(path.join(sourceRoot, 'unrelated.ts'), "export const wrong: string = 5;\nexport const Anonymous = class { private x = 1; };\n");
  const result = generate({ root, profile: { mobx: false, validation: false } });
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
    () => generate({ root, profile: { mobx: false, validation: false } }),
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
  const context = { root, suffixes: ['.entity.ts'], profile: { mobx: false, validation: false } };
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
  const result = generate({ root, sources: [path.join(sourceRoot, 'anything.ts')], profile: { mobx: false, validation: false } });
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
  const context = { root, suffixes: ['.entity.mts'], profile: { mobx: false, validation: false } };
  const result = generate(context);
  const order = result.artifacts.find(artifact => artifact.path === path.join(sourceRoot, 'order.entity.generated.mts'));
  assert.ok(order, 'the companion of an .mts source is a .generated.mts file');

  // Built and run, the order companion loads the line companion through its .mjs specifier.
  fs.writeFileSync(path.join(root, 'golem.yaml'), 'version: 1\nmodels:\n  root: .\n  suffixes: [.entity.mts]\n');
  await buildModelProject(root);
  const { TOrderBaseModel } = await import(pathToFileURL(path.join(root, 'build/order.entity.generated.mjs')).href);
  const { TLineBaseModel } = await import(pathToFileURL(path.join(root, 'build/line.entity.generated.mjs')).href);
  const decoded = decodeGeneratedModel(TOrderBaseModel, { lines: [{ sku: 'a' }] });
  assert.ok(decoded.lines[0] instanceof TLineBaseModel);
  assert.deepEqual(encodeGeneratedModel(decoded), { lines: [{ sku: 'a' }] });
});

test('the codec keys go under .golem/ of the golem.yaml directory when the job has one, named from the tsconfig directory', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, {
    'account.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TAccount = IModel<{ id: string }>;`,
  });
  const directory = path.join(root, 'config');
  const result = generate({ root, directory, profile: { mobx: false, validation: false } });
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
  const result = generate({ root, profile: { mobx: false, validation: true } });
  for (const name of ['a.model.generated.ts', 'two/b.model.generated.ts']) {
    const generated = result.artifacts.find(artifact => artifact.path.endsWith(name))?.content ?? '';
    assert.equal([...generated.matchAll(/^import \{ encodeCount as __golemSerialize0Source \} from "@fixture\/pg\/codecs";$/gm)].length, 1, `${name} binds the package import, not a copy`);
  }
});

test('with validation off, a model that opts in generates and validates, and the default model it nests stays open', async (t: TestContext) => {
  // protects: fbc92c3 a validating model compiles the undecided codecs it references: the nested Date child validates, though its model and wire schemas differ
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, {
    'rules.ts': rulesSource,
    'child.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { isEven } from './rules.js';
export type TChild = IObject<{ count: number & TValidation<typeof isEven>; at: Date }>;
`,
    'parent.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
import type { TChild } from './child.model.js';
export type TParent = IModel<{ name: string & MinLength<3>; child: TChild }, { validation: true }>;
`,
  });
  // verify-open-child.mjs runs the validators of the opt-in model and shows that the nested default model stays open.
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-generator/verify-open-child.mjs', 'verify-open-child.mjs');
  await command(root, process.execPath, [verifier, generatedCodecIdFromRoot(root, 'TParent'), generatedCodecIdFromRoot(root, 'TChild')]);
});

test('a companion imports only the validators of its own models and the companions its source imports', async (t: TestContext) => {
  const { root } = nestedPaymentProject(t);
  // The strict unused compile of the build fails on a name the companion imports and does not use, and on a module it cannot find.
  writeModelGolemYaml(root, { mobx: true, validation: true });
  await buildModelProject(root);
  const spy = await spyOnBuild(root, { '@exprtlabs/golem/conversion': ['assertAcyclicEncodeInput', 'beginEncode', 'endEncode'] });
  try {
    // The payment companion alone brings in the money companion it needs.
    const { TPaymentBaseModel, stringifyTPayment, toWireFormatTPayment } = await import(pathToFileURL(path.join(root, 'build/payment.model.generated.js')).href);
    const payment = decodeGeneratedModel(TPaymentBaseModel, NESTED_PAYMENT_WIRE);
    assert.ok(payment.total.at instanceof Date, 'the nested money converts with the decoder of its own companion');
    assert.deepEqual(encodeGeneratedModel(payment), NESTED_PAYMENT_WIRE);
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

  const { artifacts } = generate({ root, profile: { mobx: false, validation: true } });
  const companions = artifacts.map(artifact => artifact.path).filter(file => file.endsWith('.model.generated.ts'));
  assert.deepEqual(companions, [path.join(sourceRoot, 'order.model.generated.ts')]);
});

test('a job whose discovered model files all lack an alias generates nothing', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, { 'payment.model.ts': BASE_CLASS_MODEL, 'payment.model.generated.ts': SDK_COMPANION });

  const result = generate({ root, profile: { mobx: false, validation: true } });
  assert.deepEqual(result.artifacts, []);
});

test('a model file that models.sources names must hold an IModel or IObject alias', (t: TestContext) => {
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, { 'payment.model.ts': BASE_CLASS_MODEL, 'payment.model.generated.ts': SDK_COMPANION });

  assert.throws(
    () => generate({ root, sources: [path.join(sourceRoot, 'payment.model.ts')], profile: { mobx: false, validation: true } }),
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
  const { root, sharedFolder } = sharedFolderWithConfig(t, 'version: 1\nmodels:\n  root: .\n');
  const profile = { mobx: false, validation: true };

  const app = generate({ root, profile });
  assert.deepEqual(
    app.artifacts.map(artifact => artifact.path).filter(file => file.endsWith('.model.generated.ts')),
    [path.join(root, 'src/order.model.generated.ts'), path.join(root, 'src/generated/models/@acme/shared/src/money.model.generated.ts')],
  );

  const own = generate({ root: sharedFolder, profile });
  assert.deepEqual(
    own.artifacts.map(artifact => artifact.path).filter(file => file.endsWith('.model.generated.ts')),
    [path.join(sharedFolder, 'src/money.model.generated.ts')],
  );
});

test('a model source that does not exist is named relative to the working directory', (t: TestContext) => {
  // protects: T-450 a message names a local file relative to the working directory
  const { root, sourceRoot } = project(t);
  const missing = path.join(sourceRoot, 'missing.model.ts');

  assert.throws(
    () => generate({ root, sources: [missing], profile: { mobx: false, validation: true } }),
    (error: unknown) => error instanceof Error && error.message.match(/^Model source does not exist: (.*)$/)?.[1] === path.relative(process.cwd(), missing),
  );
});

test('a golem.yaml with a models job below the root of another models job stops generation with RUNM1077 naming it', (t: TestContext) => {
  // protects: R-20 nested models job is an error
  const { root, sourceRoot } = project(t);
  writeModelSources(sourceRoot, {
    'order.model.ts': ORDER_MODEL,
    'lib/golem.yaml': 'version: 1\nmodels:\n  root: .\n',
    'lib/money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TMoney = IObject<{ currency: string }>;
`,
  });

  assert.throws(
    () => generate({ root, profile: { mobx: false, validation: true } }),
    { message: `RUNM1077: ${path.relative(process.cwd(), path.join(sourceRoot, 'lib/golem.yaml'))} declares a models job below the models root ${path.relative(process.cwd(), root)}, where the models job of ${path.relative(process.cwd(), path.join(root, 'golem.yaml'))} already generates the same model files. Two jobs would write one generated file. Remove the models job from it, or move the folder out of the models root.` },
  );
});

test('a TValidation function of a folder outside the root gets an id relative to the root', (t: TestContext) => {
  // The ids are written into files that a repository keeps, so the same sources give the same files at any location.
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
    const { artifacts } = generate({ root, profile: { mobx: false, validation: true } });
    return new Map(artifacts.map(artifact => [path.relative(root, artifact.path), artifact.content]));
  };
  const first = generateAtNewLocation();
  assert.match(first.get('src/order.model.generated.ts') ?? '', /\[\\"\.\.\/shared\/rules\.ts#isEven\\"\]/, 'the id is the path from the root of the app to the function');
  assert.deepEqual(generateAtNewLocation(), first);
});

test('a golem.yaml above the golem.yaml of the job is not another job: the sources of the app are generated', (t: TestContext) => {
  const outer = sharedWorkspace(t);
  fs.writeFileSync(path.join(outer, 'package.json'), JSON.stringify({ name: 'repository', private: true, type: 'module' }));
  fs.writeFileSync(path.join(outer, 'golem.yaml'), 'version: 1\nmodels:\n  root: .\n');
  const root = path.join(outer, 'apps/a');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true },
    include: ['src/**/*.ts'],
  }));
  writeModelSources(path.join(root, 'src'), { 'order.model.ts': ORDER_MODEL });

  const { artifacts } = generate({ root, profile: { mobx: false, validation: true } });
  assert.deepEqual(
    artifacts.map(artifact => artifact.path).filter(file => file.endsWith('.model.generated.ts')),
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
      () => generate({ root, profile: { mobx: false, validation: true } }),
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

  const { artifacts } = generate({ root, profile: { mobx: false, validation: true } });
  assert.deepEqual(artifacts.map(artifact => artifact.path).filter(file => file.endsWith('.model.generated.ts')), [path.join(root, 'src/order.model.generated.ts')]);
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

  const { artifacts } = generate({ root, profile: { mobx: false, validation: true } });
  assert.deepEqual(
    artifacts.map(artifact => artifact.path).filter(file => file.endsWith('.model.generated.ts')),
    [path.join(root, 'src/order.model.generated.ts')],
  );
});

test('no generated file is written outside the models root', (t: TestContext) => {
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

  const { artifacts } = generate({ root, profile: { mobx: false, validation: true } });
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
    () => generate({ root, sources: [path.join(root, 'src/order.model.ts'), money], profile: { mobx: false, validation: true } }),
    { message: `RUNM1075: models.sources entry ${money} is outside the models root ${root}. A models job generates only files inside its root.` },
  );
});

test('a sources entry that links to a file outside the models root stops generation with RUNM1075 and its real path', (t: TestContext) => {
  const outer = sharedWorkspace(t);
  const money = sharedMoneyModel(outer);
  const root = appProject(outer, 'a', 'src/**/*.ts');
  fs.symlinkSync(money, path.join(root, 'src/money.model.ts'));

  assert.throws(
    () => generate({ root, sources: [path.join(root, 'src/money.model.ts')], profile: { mobx: false, validation: true } }),
    { message: `RUNM1075: models.sources entry ${money} is outside the models root ${root}. A models job generates only files inside its root.` },
  );
});

test('a sources entry inside a nested golem.yaml with a models job stops generation with RUNM1077', (t: TestContext) => {
  // protects: R-20 nested models job is an error, also for a listed sources entry
  const outer = sharedWorkspace(t);
  const root = appProject(outer, 'a', 'src/**/*.ts');
  writeModelSources(path.join(root, 'src'), {
    'lib/golem.yaml': 'version: 1\nmodels:\n  root: .\n',
    'lib/money.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
export type TMoney = IObject<{ currency: string }>;
`,
  });

  assert.throws(
    () => generate({ root, sources: [path.join(root, 'src/lib/money.model.ts')], profile: { mobx: false, validation: true } }),
    (error: unknown) => error instanceof Error
      && error.message.startsWith(`RUNM1077: ${path.relative(process.cwd(), path.join(fs.realpathSync(root), 'src/lib/golem.yaml'))} declares a models job below the models root ${path.relative(process.cwd(), fs.realpathSync(root))}, where `),
  );
});

