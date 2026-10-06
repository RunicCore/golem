import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import * as ts from '@exprtlabs/golem/ts';
import { isModelDeclarationReference } from '@exprtlabs/golem/type-analysis';
import { command } from './support/process.js';
import { generatedCodecIdFromRoot } from './support/consumer.js';
import { companionModelProject, modelProject } from './support/model-companion-project.js';
import {
  buildModelProject,
  generatedModelFiles,
  writeModelGolemYaml,
  writeModelSources,
} from './model-project.js';
import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
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
    profile: { ...profile, allowAny: false },
    // A validating model that references this one compiles its schema into its own validators.
    ...(profile.validation ? {
      validationSchemaClosure: [{
        codecId: 'fixture:money',
        modelSchema: { type: 'object', properties: { currency: { type: 'string' }, amount: { type: 'number' } }, required: ['currency', 'amount'], additionalProperties: false },
      }],
    } : {}),
    models: [{
      id: 'fixture:money',
      allowAny: false,
      type: { module: typeModule, export: 'Money' },
      generated: { module: generatedModule, export: generatedExport },
    }],
  }));
}

test('generated model names are scoped to their companion modules', (t) => {
  const { root, sourceRoot } = modelProject(t);
  writeModelSources(sourceRoot, {
    'first.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';\nexport type TItem = IModel<{ first: string }>;\n`,
    'second.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';\nexport type TItem = IModel<{ second: string }>;\n`,
  });
  const result = generate({ root, profile: { mobx: false, validation: false } });
  assert.equal(result.artifacts.length, 4);
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

test('same-file aliases that differ only by the T prefix generate two separate models', async (t) => {
  const { root, sourceRoot } = modelProject(t);
  writeModelSources(sourceRoot, {
    'payment.model.ts': readFixture('models/model-companions/duplicate-model/payment.model.ts'),
  });
  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const artifacts = generatedModelFiles(root);
  const companion = artifacts.find((artifact) => artifact.path.endsWith('payment.model.generated.ts'))?.content ?? '';
  assert.match(companion, /export abstract class TPaymentBaseModel\b/);
  assert.match(companion, /export abstract class PaymentBaseModel\b/);
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

test('re-exported IModel and IObject symbols preserve class versus plain-object generation', async t => {
  const { root, sourceRoot } = companionModelProject(t, 'model-kind-provenance');
  fs.writeFileSync(path.join(sourceRoot, 'contracts.ts'), readFixture('models/model-companions/contracts.ts'));
  const sourceFile = path.join(sourceRoot, 'provenance.model.ts');
  fs.writeFileSync(sourceFile, readFixture('models/model-companions/provenance.model.ts'));

  writeModelGolemYaml(root, { mobx: false, validation: false });
  await buildModelProject(root);
  const generated = generatedModelFiles(root).find(artifact => artifact.path.endsWith('provenance.model.generated.ts'))?.content ?? '';
  assert.match(generated, /export abstract class TProvenanceBaseModel/);
  assert.doesNotMatch(generated, /export abstract class PlainBaseModel/);
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

test('a job without validation writes a layer that holds no validators', (t) => {
  const { root, sourceRoot } = modelProject(t);
  writeModelSources(sourceRoot, {
    'item.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TItem = IModel<{ title: string & MinLength<1> }>;
`,
  });
  const result = generate({ root, profile: { mobx: false, validation: false } });
  const layer = result.artifacts.find(artifact => artifact.path.endsWith('models.generated.ts'));
  assert.match(layer?.content ?? '', /profile: Object\.freeze\(\{ validation: false, mobx: false \}\)/);
  assert.match(layer?.content ?? '', /validators: Object\.freeze\(\{ \}\)/);
  assert.equal(result.artifacts.some(artifact => artifact.path.endsWith('models.validators.generated.ts')), false);
});

/** Builds a project whose layer has `profile`, then runs the verifier against the built companion. */
async function verifyLayerProfile(
  t: TestContext,
  profile: { readonly mobx: boolean; readonly validation: boolean },
  expectation: 'validates' | 'accepts',
): Promise<void> {
  const { root, sourceRoot } = companionModelProject(t, 'layer-profile');
  writeModelSources(sourceRoot, {
    'order.model.ts': tsSource`import type { IModel, IObject } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TMoney = IObject<{ currency: string & MinLength<3> }>;
export type TOrder = IModel<{ total: TMoney }>;
`,
  });
  writeModelGolemYaml(root, profile);
  await buildModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-companions/verify-layer-profile.mjs', 'verify-layer-profile.mjs');
  await command(root, process.execPath, [verifier, generatedCodecIdFromRoot(root, 'TOrder'), expectation]);
}

test('validation and the MobX hook follow the layer: a validating app rejects the short currency and observes the validator', async (t) => {
  await verifyLayerProfile(t, { mobx: true, validation: true }, 'validates');
});

test('validation and the MobX hook follow the layer: an app without validation parses the same value', async (t) => {
  await verifyLayerProfile(t, { mobx: true, validation: false }, 'accepts');
});

test('a custom validation binding is imported by the generated validators and the layer imports those', (t) => {
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
  assert.match(validators.content, /import \{ isEven as \w+ \} from "[^"]*rules\.js"/);
  const companion = result.artifacts.find(artifact => artifact.path.endsWith('item.model.generated.ts'));
  const layer = result.artifacts.find(artifact => artifact.path.endsWith('models.generated.ts'));
  assert.match(layer?.content ?? '', /from "\.\/models\.validators\.generated\.js"/);
  assert.doesNotMatch(companion?.content ?? '', /validators\.generated/);
});
