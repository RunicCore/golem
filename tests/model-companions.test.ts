import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import * as ts from '@exprtlabs/golem/internal/ts';
import { isModelDeclarationReference } from '@exprtlabs/golem/internal/type-analysis';
import { command } from './support/process.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { companionModelProject, modelProject } from './support/model-companion-project.js';
import {
  buildModelProject,
  generatedModelFiles,
  writeModelGolemYaml,
  writeModelSources,
} from './model-project.js';
import { copyFixtureFile, fileFixtureScope, onceShared, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { runRewritten } from './support/rewritten-module.js';
import { tsSource } from './source-template.js';
import { generate } from '#model/generator';

function writeManifest(
  filename: string,
  generatedModule: string,
  generatedExport: string,
  typeModule = './types.ts',
  profile: { readonly mobx: boolean; readonly validation: boolean } = { mobx: false, validation: false },
): void {
  fs.writeFileSync(filename, JSON.stringify({
    profile: { ...profile, allowAny: false, unknownFormats: 'error' },
    // A validating model that references this one compiles its schema into its own validators.
    ...(profile.validation ? {
      validationSchemaClosure: [{
        codecId: 'fixture:money',
        modelSchema: { type: 'object', properties: { currency: { type: 'string' }, amount: { type: 'number' } }, required: ['currency', 'amount'], additionalProperties: false },
      }],
    } : {}),
    models: [{
      id: 'fixture:money',
      codecId: 'fixture:money',
      allowAny: false,
      type: { module: typeModule, export: 'Money' },
      generated: { module: generatedModule, export: generatedExport },
    }],
  }));
}

const fileScope = fileFixtureScope();

// The tests below that only read a build share it: one project of the models they read, built once.
/** Models with validation off, in one project: the duplicate-name pair, the re-exported kinds, and a model with a tag. */
const trustedProject = onceShared(async () => {
  const { root, sourceRoot } = companionModelProject(fileScope, 'validation-off');
  writeModelSources(sourceRoot, {
    'payment.model.ts': readFixture('models/model-companions/duplicate-model/payment.model.ts'),
    'contracts.ts': readFixture('models/model-companions/contracts.ts'),
    'provenance.model.ts': readFixture('models/model-companions/provenance.model.ts'),
    'a.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TA = IModel<{ title: string & MinLength<1> }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  return { root, sourceRoot, artifacts: generatedModelFiles(root) };
});

/** Models with validation on: two models that import each other. */
const validatingProject = onceShared(async () => {
  const { root, sourceRoot } = companionModelProject(fileScope, 'validation-on');
  writeModelSources(sourceRoot, {
    'node.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TLink } from './link.model.js';
export type TNode = IObject<{ next?: TLink }>;
`,
    'link.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { TNode } from './node.model.js';
export type TLink = IObject<{ node: TNode }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  return { root };
});

test('generated model names are scoped to their companion modules', (t) => {
  const { root, sourceRoot } = modelProject(t);
  writeModelSources(sourceRoot, {
    'first.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';\nexport type TItem = IModel<{ first: string }>;\n`,
    'second.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';\nexport type TItem = IModel<{ second: string }>;\n`,
  });
  const result = generate({ root, profile: { mobx: false, validation: false } });
  assert.equal(result.artifacts.length, 3);
  assert.equal(result.artifacts.filter((artifact) => artifact.content.includes('export abstract class TItemBaseModel')).length, 2);
  assert.equal(result.artifacts.some((artifact) => artifact.content.includes('first')), true);
  assert.equal(result.artifacts.some((artifact) => artifact.content.includes('second')), true);
  const keys = result.artifacts.find((artifact) => artifact.path.endsWith('codec-keys.json'))?.content ?? '';
  const firstId = keys.match(/src\/first\.model\.ts#TItem": "([^"]+)"/)?.[1];
  const secondId = keys.match(/src\/second\.model\.ts#TItem": "([^"]+)"/)?.[1];
  assert.match(firstId ?? '', /^TItem_[0-9a-f]{8}$/);
  assert.match(secondId ?? '', /^TItem_[0-9a-f]{8}$/);
  assert.notEqual(firstId, secondId);
});

test('same-file aliases that differ only by the T prefix generate two separate models', async () => {
  const { root, artifacts } = await trustedProject();
  const built = await import(path.toNamespacedPath(path.join(root, 'build/payment.model.generated.js'))) as Record<string, unknown>;
  assert.deepEqual(Object.keys(built).filter((name) => name.endsWith('BaseModel')).sort(), ['PaymentBaseModel', 'TPaymentBaseModel']);
  const keys = artifacts.find((artifact) => artifact.path.endsWith('codec-keys.json'))?.content ?? '';
  const tId = keys.match(/payment\.model\.ts#TPayment": "([^"]+)"/)?.[1];
  const id = keys.match(/payment\.model\.ts#Payment": "([^"]+)"/)?.[1];
  assert.match(tId ?? '', /^TPayment_[0-9a-f]{8}$/);
  assert.match(id ?? '', /^Payment_[0-9a-f]{8}$/);
});

test('automatic empty discovery returns an empty expected artifact set', (t) => {
  const { root, sourceRoot } = modelProject(t);
  const source = path.join(sourceRoot, 'item.model.ts');
  writeModelSources(sourceRoot, { 'item.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';\nexport type TItem = IModel<{ value: string }>;\n` });
  const first = generate({ root, profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(first.artifacts);
  fs.rmSync(source);
  const empty = generate({ root, profile: { mobx: false, validation: false } });
  assert.deepEqual(empty.artifacts, []);
  assert.equal(empty.manifestPaths.length, 0);
});

function ambientInvoiceProject(t: TestContext): { readonly root: string; readonly ambient: string } {
  const { root, sourceRoot } = modelProject(t);
  const ambient = path.join(sourceRoot, 'global.d.ts');
  fs.writeFileSync(ambient, 'interface Money { currency: string; }\n');
  writeModelSources(sourceRoot, { 'invoice.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';\nexport type TInvoice = IModel<{ money: Money }>;\n` });
  return { root, ambient };
}

test('tsconfig ambient declarations participate in executable validation', async (t) => {
  const { root } = ambientInvoiceProject(t);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const invoiceId = generatedCodecIdFromRoot(root, 'TInvoice');
  const verifier = copyFixtureFile(root, 'models/model-companions/verify-ambient-validation.mjs', 'verify-ambient-validation.mjs');
  await command(root, process.execPath, [verifier, invoiceId]);
});

test('tsconfig ambient declarations are inputs a watching build follows', (t) => {
  const { root, ambient } = ambientInvoiceProject(t);
  const result = generate({ root, profile: { mobx: false, validation: true } });
  assert.equal(result.watchInputs.includes(ambient), true);
});

test('missing manifest modules and runtime exports fail before companion emission', (t) => {
  const { root, sourceRoot } = modelProject(t);
  const sdk = path.join(sourceRoot, 'sdk');
  fs.mkdirSync(sdk, { recursive: true });
  const types = path.join(sdk, 'types.ts');
  const manifest = path.join(sdk, 'model-manifest.json');
  const source = path.join(sourceRoot, 'aggregate.model.ts');
  fs.writeFileSync(types, '/* @golem-model-manifest ./model-manifest.json */\nexport interface Money { currency: string }\n');
  writeModelSources(sourceRoot, {
    'aggregate.model.ts': readFixture('models/model-companions/missing-manifest/aggregate.model.ts'),
  });
  writeManifest(manifest, './missing-models.ts', 'MoneyModel');
  assert.throws(
    () => generate({ root, sources: [source], profile: { mobx: false, validation: false }, manifestInputs: [manifest] }),
    /missing generated module/,
  );
  const generated = path.join(sdk, 'models.ts');
  fs.writeFileSync(generated, 'export const Other = 1;\n');
  writeManifest(manifest, './models.ts', 'MoneyModel');
  assert.throws(
    () => generate({ root, sources: [source], profile: { mobx: false, validation: false }, manifestInputs: [manifest] }),
    /missing runtime export/,
  );
});

test('public generation compiles and executes conversion and rest tuple behavior', async (t) => {
  const { root, sourceRoot } = modelProject(t);
  const sdk = path.join(sourceRoot, 'sdk');
  fs.mkdirSync(sdk, { recursive: true });
  copyFixtureFile(root, 'models/model-companions/sdk-types/types.ts', 'src/sdk/types.ts');
  fs.writeFileSync(path.join(sdk, 'models.ts'), readFixture("models/model-companions/public-generation-compiles-and-executes-conversion-and-rest-tuple-behavior/models.ts"));
  writeManifest(path.join(sdk, 'model-manifest.json'), './models.ts', 'MoneyModel', './types.ts', { mobx: false, validation: true });
  copyFixtureFile(root, 'models/model-companions/public-generation-compiles-and-executes-conversion-and-rest-tuple-behavior/wallet.model.ts', 'src/wallet.model.ts');
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-companions/verify-public-generation.mjs', 'verify-public-generation.mjs');
  await command(root, process.execPath, [verifier]);
});

// Writes the SDK folder whose Money is an IObject alias, with the generated MoneyModel and its manifest.
function installSdkMoney(
  sourceRoot: string,
  types = "/* @golem-model-manifest ./model-manifest.json */\nimport type { IObject } from '@exprtlabs/golem/model';\nexport type Money = IObject<{ currency: string; amount: number }>;\n",
): void {
  const sdk = path.join(sourceRoot, 'sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'types.ts'), types);
  fs.writeFileSync(path.join(sdk, 'models.ts'), readFixture('models/model-companions/public-generation-compiles-and-executes-conversion-and-rest-tuple-behavior/models.ts'));
  writeManifest(path.join(sdk, 'model-manifest.json'), './models.ts', 'MoneyModel', './types.ts', { mobx: false, validation: true });
}

test('an app model that nests an SDK model written as an IObject alias uses the SDK class: parse and stringify round-trip', async (t) => {
  // protects: T-206 an SDK IObject alias nested in an app model generates (RUNM1053 judged the alias anonymous before the manifest was read)
  const { root, sourceRoot } = modelProject(t);
  installSdkMoney(sourceRoot);
  writeModelSources(sourceRoot, {
    'order.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { Money } from './sdk/types.js';
export type TOrder = IObject<{ id: string; money: Money }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-companions/verify-sdk-alias.mjs', 'verify-sdk-alias.mjs');
  await command(root, process.execPath, [verifier, generatedCodecIdFromRoot(root, 'TOrder')]);
});

test('an SDK IObject alias nested as Money | null, (Money | null)[] and NonNullable<Money> uses the SDK class, and null stays null', async (t) => {
  // protects: T-206 final review: a nullable SDK alias is the SDK model, never an inlined plain object
  const { root, sourceRoot } = modelProject(t);
  installSdkMoney(sourceRoot);
  writeModelSources(sourceRoot, {
    'order.model.ts': tsSource`import type { IObject } from '@exprtlabs/golem/model';
import type { Money } from './sdk/types.js';
export type TOrder = IObject<{ id: string; money: Money | null; history: (Money | null)[]; kept: NonNullable<Money> }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-companions/verify-sdk-alias-nullable.mjs', 'verify-sdk-alias-nullable.mjs');
  await command(root, process.execPath, [verifier, generatedCodecIdFromRoot(root, 'TOrder')]);
});

test('re-exported IModel and IObject symbols preserve class versus plain-object generation', async () => {
  const { root, sourceRoot, artifacts } = await trustedProject();
  const sourceFile = path.join(sourceRoot, 'provenance.model.ts');
  const built = await import(path.toNamespacedPath(path.join(root, 'build/provenance.model.generated.js'))) as Record<string, unknown>;
  assert.deepEqual(Object.keys(built).filter((name) => name.endsWith('BaseModel')), ['TProvenanceBaseModel'], 'only the IModel alias gets a class');
  {
    using program = ts.createProgramFromSources({ root, sources: [sourceFile] });
    const aliases = program.getSourceFile(sourceFile)?.statements.filter(ts.isTypeAliasDeclaration) ?? [];
    assert.equal(aliases.length, 2);
    for (const alias of aliases) assert.equal(isModelDeclarationReference(program.getTypeChecker(), alias.type), true);
  }

  const loaded = await import(pathToFileURL(path.join(root, 'build/provenance.model.js')).href) as {
    readonly Provenance: new (values?: object) => object;
    readonly model: object;
    readonly plain: object;
  };
  assert.ok(loaded.model instanceof loaded.Provenance);
  assert.equal(Object.getPrototypeOf(loaded.plain), Object.prototype);
  assert.deepEqual(loaded.plain, { label: 'plain' });
});

test('two models that import each other load and validate across the cycle', async () => {
  const { root } = await validatingProject();
  const verifier = copyFixtureFile(root, 'models/model-companions/verify-import-cycle.mjs', 'verify-import-cycle.mjs');
  await command(root, process.execPath, [verifier, generatedCodecIdFromRoot(root, 'TNode')]);
});

test('the first generation after an upgrade deletes the old models.generated.ts', async (t) => {
  const { root, sourceRoot } = companionModelProject(t, 'upgrade-layer');
  writeModelSources(sourceRoot, {
    'a.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TA = IModel<{ title: string }>;
`,
  });
  writeModelGolemYaml(root, { mobx: false, validation: true });
  await buildModelProject(root);
  // The inventory a release before this change wrote: it owns models.generated.ts beside the validators.
  const inventoryFile = path.join(root, '.golem/outputs.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8')) as { files: Record<string, unknown> };
  const validatorsKey = Object.keys(inventory.files).find((key) => key.endsWith('models.validators.generated.ts')) ?? '';
  assert.notEqual(validatorsKey, '');
  const oldKey = validatorsKey.replace('models.validators.generated.ts', 'models.generated.ts');
  inventory.files[oldKey] = inventory.files[validatorsKey];
  fs.writeFileSync(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`);
  const oldFile = path.join(root, oldKey);
  // A new release also runs its jobs again: the job cache of the old release does not apply.
  fs.rmSync(path.join(root, '.golem/jobs.json'));
  fs.writeFileSync(oldFile, '/* Generated by @exprtlabs/golem-model. Do not edit. */\nexport const layer = {};\n');

  await buildModelProject(root);

  assert.equal(fs.existsSync(oldFile), false);
});

test('a custom validation binding is imported by the generated validators and the model file imports those', (t) => {
  const { root, sourceRoot } = modelProject(t);
  writeModelSources(sourceRoot, {
    'rules.ts': tsSource`export function isEven(value: number): boolean | string { return value % 2 === 0 || 'must be even'; }
`,
    'item.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { TValidation } from '@exprtlabs/golem/tags';
import { isEven } from './rules.js';
export type TItem = IModel<{ count: number & TValidation<typeof isEven> }>;
`,
  });
  const result = generate({ root, profile: { mobx: false, validation: true } });
  const validators = result.artifacts.find(artifact => artifact.path.endsWith('models.validators.generated.ts'));
  assert.ok(validators, 'the validators file is written');
  assert.ok(runRewritten(validators.content).imports.some((specifier) => specifier.endsWith('rules.js')), 'the validators module imports the user function');
  const companion = result.artifacts.find(artifact => artifact.path.endsWith('item.model.generated.ts'));
  assert.deepEqual(runRewritten(companion?.content).imports.filter((specifier) => specifier.includes('validators') || specifier.endsWith('rules.js')), ['./generated/models/models.validators.generated.js'], 'the companion reaches the user function only through the validators module');
});
