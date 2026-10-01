import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

import * as ts from '@exprtlabs/golem/ts';
import { isModelDeclarationReference } from '@exprtlabs/golem/type-analysis';
import { command } from './support/process.js';
import { generatedCodecId } from './support/consumer.js';
import {
  compileModelProject,
  createModelProject,
  writeModelSources,
} from './model-project.js';
import { copyFixtureFile, readFixture, writeGeneratedArtifacts } from './fixture-project.js';
import { companionModelSource } from './fixture-templates/models/model-companions.js';
import { tsSource } from './source-template.js';
import { generate } from '#model/generator';

const modelProject = (t: Parameters<typeof createModelProject>[0]) => createModelProject(t, {
  prefix: 'golem-model-companions-',
  name: 'model-companions',
});

function writeManifest(
  filename: string,
  generatedModule: string,
  generatedExport: string,
  typeModule = './types.ts',
  profile: { readonly mobx: boolean; readonly validation: boolean } = { mobx: false, validation: false },
): void {
  fs.writeFileSync(filename, JSON.stringify({
    profile: { ...profile, ajvStandalone: false, allowAny: false },
    models: [{
      id: 'fixture:money',
      allowAny: false,
      type: { module: typeModule, export: 'Money' },
      generated: { module: generatedModule, export: generatedExport },
    }],
  }));
}

function ttscModelProject(t: TestContext, name: string) {
  return createModelProject(t, {
    prefix: `golem-${name}-`,
    name,
    ttscPlugin: true,
    linkWorkspaceNodeModules: true,
  });
}

test('model companions compile with --noUnusedLocals for empty, scalar and nested models', async t => {
  const { root, sourceRoot } = modelProject(t);
  const modelNames = ['Empty', 'Scalar', 'Nested'] as const;
  for (const mobx of [false, true]) for (const validation of [false, true]) {
    const profile = { mobx, validation };
    for (const name of modelNames) {
      const stem = name.toLowerCase();
      writeModelSources(sourceRoot, { [`${stem}.model.ts`]: companionModelSource({ name, mobx }) });
    }
    const result = generate({ root, profile });
    for (const artifact of result.artifacts) {
      const modelName = modelNames.find(name => path.basename(artifact.path) === `${name.toLowerCase()}.model.generated.ts`);
      if (!modelName) {
        const base = path.basename(artifact.path);
        assert.ok(base === 'models.generated.ts' || base === 'iobject-plugin-keys.ts', base);
        continue;
      }
      assert.match(artifact.content, new RegExp(`function fillT${modelName}\\(`), `${modelName}: shared fill`);
    }
    writeGeneratedArtifacts(result.artifacts);
    await compileModelProject(root, ['--noUnusedLocals', '--noUnusedParameters']);
    // Execution does not depend on the profile, so the verifier runs once.
    if (mobx && validation) {
      const verifier = copyFixtureFile(root, 'models/model-companions/verify-empty-scalar-nested.mjs', 'verify.mjs');
      await command(root, process.execPath, [verifier]);
    }
  }
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
  const keys = result.artifacts.find((artifact) => artifact.path.endsWith('iobject-plugin-keys.ts'))?.content ?? '';
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
  const result = generate({ root, profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
  const companion = result.artifacts.find((artifact) => artifact.path.endsWith('payment.model.generated.ts'))?.content ?? '';
  assert.match(companion, /export abstract class TPaymentBaseModel\b/);
  assert.match(companion, /export abstract class PaymentBaseModel\b/);
  const keys = result.artifacts.find((artifact) => artifact.path.endsWith('iobject-plugin-keys.ts'))?.content ?? '';
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

test('tsconfig ambient declarations participate in executable validation and watching', async (t) => {
  const { root, sourceRoot } = modelProject(t);
  const ambient = path.join(sourceRoot, 'global.d.ts');
  fs.writeFileSync(ambient, 'interface Money { currency: string; }\n');
  const source = path.join(sourceRoot, 'invoice.model.ts');
  writeModelSources(sourceRoot, { 'invoice.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';\nexport type TInvoice = IModel<{ money: Money }>;\n` });
  const result = generate({ root, sources: [source], profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  const invoiceId = generatedCodecId(result.artifacts.map((artifact) => artifact.content).join('\n'), 'TInvoice');
  await compileModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-companions/verify-ambient-validation.mjs', 'verify-ambient-validation.mjs');
  await command(root, process.execPath, [verifier, invoiceId]);
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
  const source = copyFixtureFile(root, 'models/model-companions/public-generation-compiles-and-executes-conversion-and-rest-tuple-behavior/wallet.model.ts', 'src/wallet.model.ts');
  const result = generate({ root, sources: [source], profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-companions/verify-public-generation.mjs', 'verify-public-generation.mjs');
  await command(root, process.execPath, [verifier]);
});

test('ttsc rewrites nested model serde calls and preserves class construction in CRLF source', async t => {
  const { root, sourceRoot } = ttscModelProject(t, 'model-serde-edit');
  const source = readFixture('models/model-companions/serde-edit.model.ts').replaceAll('\n', '\r\n');
  const sourceFile = path.join(sourceRoot, 'item.model.ts');
  fs.writeFileSync(sourceFile, source);

  const result = generate({ root, sources: [sourceFile], profile: { mobx: false, validation: true } });
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);

  const emitted = fs.readFileSync(path.join(root, 'build/item.model.js'), 'utf8');
  assert.match(emitted, /requireObjectCodec\("TItem_[0-9a-f]{8}"\)\.parse\(/);
  assert.match(emitted, /requireObjectCodec\("TItem_[0-9a-f]{8}"\)\.fromWireFormat\(/);
  assert.match(emitted, /construct: Item/);
  const firstEmit = emitted;
  await compileModelProject(root);
  assert.equal(fs.readFileSync(path.join(root, 'build/item.model.js'), 'utf8'), firstEmit);

  const loaded = await import(pathToFileURL(path.join(root, 'build/item.model.js')).href) as {
    readonly Item: new (values?: object) => object;
  };
  const item = new loaded.Item();
  const parsed = (item as { parseTItem(text: string): object }).parseTItem('{"title":"nested","value":7}');
  assert.ok(parsed instanceof loaded.Item);
  const wired = (item as { fromWireItem(value: unknown): object }).fromWireItem({ title: 'wire', value: 8 });
  assert.deepEqual({ ...wired }, { title: 'wire', value: 8 });
  assert.ok(wired instanceof loaded.Item);
});

test('re-exported IModel and IObject symbols preserve class versus plain-object generation', async t => {
  const { root, sourceRoot } = ttscModelProject(t, 'model-kind-provenance');
  fs.writeFileSync(path.join(sourceRoot, 'contracts.ts'), readFixture('models/model-companions/contracts.ts'));
  const sourceFile = path.join(sourceRoot, 'provenance.model.ts');
  fs.writeFileSync(sourceFile, readFixture('models/model-companions/provenance.model.ts'));

  const result = generate({ root, sources: [sourceFile], profile: { mobx: false, validation: false } });
  writeGeneratedArtifacts(result.artifacts);
  const generated = result.artifacts.find(artifact => artifact.path.endsWith('provenance.model.generated.ts'))?.content ?? '';
  assert.match(generated, /export abstract class ProvenanceBaseModel/);
  assert.doesNotMatch(generated, /export abstract class PlainBaseModel/);
  {
    using program = ts.createProgramFromSources({ root, sources: [sourceFile] });
    const aliases = program.getSourceFile(sourceFile)?.statements.filter(ts.isTypeAliasDeclaration) ?? [];
    assert.equal(aliases.length, 2);
    for (const alias of aliases) assert.equal(isModelDeclarationReference(program.getTypeChecker(), alias.type), true);
  }
  await compileModelProject(root);

  const loaded = await import(pathToFileURL(path.join(root, 'build/provenance.model.js')).href) as {
    readonly Provenance: new (values?: object) => object;
    readonly model: object;
    readonly plain: object;
  };
  assert.ok(loaded.model instanceof loaded.Provenance);
  assert.equal(Object.getPrototypeOf(loaded.plain), Object.prototype);
  assert.deepEqual(loaded.plain, { label: 'plain' });
});

test('a job without validation or serde bindings writes no shared bindings file', (t) => {
  const { root, sourceRoot } = modelProject(t);
  writeModelSources(sourceRoot, {
    'item.model.ts': tsSource`import type { IModel } from '@exprtlabs/golem/model';
import type { MinLength } from '@exprtlabs/golem/tags';
export type TItem = IModel<{ title: string & MinLength<1> }>;
`,
  });
  const result = generate({ root, profile: { mobx: false, validation: true } });
  assert.equal(result.artifacts.some(artifact => artifact.path.endsWith('models.generated.ts')), false);
});

test('a custom validation binding writes the shared file and the companion imports it', (t) => {
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
  const shared = result.artifacts.find(artifact => artifact.path.endsWith('models.generated.ts'));
  assert.ok(shared, 'shared bindings file is written');
  assert.match(shared.content, /export const modelValidationBindings/);
  const companion = result.artifacts.find(artifact => artifact.path.endsWith('item.model.generated.ts'));
  assert.match(companion?.content ?? '', /from "\.\/generated\/models\/models\.generated\.js"/);
});
