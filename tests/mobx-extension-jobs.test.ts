import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { packageExport } from '@exprtlabs/golem/internal/emitter';
import type { HookFill } from '@exprtlabs/golem/generator-api';
import { generate } from '#model/generator';
import { writeSdk } from '#openapi/generator';
import { createFixtureProject } from './fixture-project.js';
import { buildModelProjectWith, createModelProject, generatedModelFiles, writeModelSources } from './model-project.js';
import { documentBase, generateMaterializedSdk } from './openapi/helpers.js';
import { tsSource } from './source-template.js';

const ORDER = tsSource`import type { IModel } from '@exprtlabs/golem/model';
export type TOrder = IModel<{ id: string }>;
`;

async function orderModelFile(t: TestContext, profile: Parameters<typeof buildModelProjectWith>[1]): Promise<string> {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-mobx-jobs-', name: 'mobx-jobs' });
  writeModelSources(sourceRoot, { 'order.model.ts': ORDER });
  await buildModelProjectWith(root, profile);
  const file = generatedModelFiles(root).find(({ path: filename }) => filename.endsWith('order.model.generated.ts'));
  assert.ok(file, 'the build writes the companion of order.model.ts');
  return file.content;
}

test('a project with only a model job gets the MobX validator enhancer when the openapi-ts block turns the extension on', async (t: TestContext) => {
  // protects: F-892 the mobx extension works in a project with no SDK job: its model.validatorEnhancer hook fills the model job
  const content = await orderModelFile(t, { mobx: true, validation: true });
  assert.match(content, /^import \{ enhanceValidatorWithMobX \} from '@exprtlabs\/golem-openapi-ts\/internal\/mobx-validation-runtime';$/m);
  assert.match(content, /^  enhanceValidator: enhanceValidatorWithMobX,$/m);
});

test('a project without the extension writes no validator enhancer', async (t: TestContext) => {
  // protects: P-41 core hardcodes no MobX: the enhancer line comes only from the extension's hook
  const content = await orderModelFile(t, { validation: true });
  assert.doesNotMatch(content, /enhanceValidator/);
});

test('an SDK job in golem mode with the extension on writes observable operations', async (t: TestContext) => {
  // protects: P-41 the client.operationWrapper hook gives the observable client
  const document = documentBase('3.1.0', { paths: { '/items': { get: { operationId: 'listItems', responses: { 200: { description: 'ok' } } } } } });
  const output = path.join(createFixtureProject(t, 'golem-mobx-sdk-'), 'sdk');
  await generateMaterializedSdk(document, { output, name: 'Items', profile: { mobx: true, validation: false }, mode: 'golem' });
  const operations = fs.readdirSync(path.join(output, 'operations')).map((name) => fs.readFileSync(path.join(output, 'operations', name), 'utf8')).join('\n');
  assert.match(operations, /import \{ createObservableApiOperation as createApiOperation \} from '@exprtlabs\/golem-openapi-ts\/internal\/mobx-runtime';/);
});

/** The fill of an extension with the import key `acme`, which no emitter lists: the participant gives the Code of its package export. */
function acmeFill(participant: () => unknown): HookFill {
  return { package: '@acme/pkg', extension: 'acme', options: {}, participant, use: (call) => call(participant) };
}

test('a validator enhancer with an import key that no emitter lists still generates', (t: TestContext) => {
  // protects: P-41 the emitters read import keys from the hook's Code, so an extension other than mobx needs no key in them
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-acme-jobs-', name: 'acme-jobs' });
  writeModelSources(sourceRoot, { 'order.model.ts': ORDER });
  const enhancer = acmeFill(() => packageExport({
    key: 'acme', specifier: '@exprtlabs/golem-openapi-ts/internal/mobx-validation-runtime', typeSpecifier: '@exprtlabs/golem-openapi-ts/mobx-validation', name: 'enhanceValidatorWithMobX',
  }));
  const result = generate({ root, sources: [path.join(sourceRoot, 'order.model.ts')], profile: { validation: true }, hooks: { 'model.validatorEnhancer': [enhancer] } });
  const content = result.artifacts.find(({ path: filename }) => filename.endsWith('order.model.generated.ts'))?.content ?? '';
  assert.match(content, /^import \{ enhanceValidatorWithMobX \} from '@exprtlabs\/golem-openapi-ts\/internal\/mobx-validation-runtime';$/m);
  assert.match(content, /^  enhanceValidator: enhanceValidatorWithMobX,$/m);
});

test('an operation wrapper with an import key that no emitter lists still generates', (t: TestContext) => {
  // protects: P-41 the emitters read import keys from the hook's Code, so a wrapper other than mobx needs no key in them
  const document = documentBase('3.1.0', { paths: { '/items': { get: { operationId: 'listItems', responses: { 200: { description: 'ok' } } } } } });
  const wrapper = acmeFill(() => ({ wrapper: {
    operationType: packageExport({ key: 'acme', specifier: '@acme/pkg/internal/run', typeSpecifier: '@acme/pkg', name: 'AcmeOperation', typeOnly: true }),
    createOperation: packageExport({ key: 'acme', specifier: '@acme/pkg/internal/run', typeSpecifier: '@acme/pkg', name: 'createAcmeOperation' }),
  } }));
  const output = path.join(createFixtureProject(t, 'golem-acme-sdk-'), 'sdk');
  const result = writeSdk(document, { output, name: 'Items', profile: { validation: false }, hooks: { 'client.operationWrapper': [wrapper] } });
  const operations = result.artifacts.filter(({ path: filename }) => filename.includes('/operations/')).map(({ content }) => content).join('\n');
  assert.match(operations, /import \{ createAcmeOperation \} from '@acme\/pkg\/internal\/run';/);
  assert.match(operations, /import type \{ AcmeOperation \} from '@acme\/pkg';/);
});
