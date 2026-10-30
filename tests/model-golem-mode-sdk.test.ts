import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import { stableJson } from '#golem/generator-core';
import { isGolemModeManifest, sdkSchemaGraph, validateModelManifest } from '#golem/model-manifest-core';
import { normalizeAndValidate } from '#openapi/document';
import { generateModelManifest } from '#openapi/model-manifest';
import { analyzeOpenApiModels } from '#openapi/model-schema-graph';
import { generate } from '#model/generator';
import { createModelProject, writeModelSources } from './model-project.js';

const PROFILE = { mobx: false, validation: true, allowAny: false } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function document(format: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'Charges', version: '1' },
    paths: {
      '/charges': {
        post: {
          operationId: 'createCharge',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['note'], properties: { note: { type: 'string', format }, when: { type: 'string', format: 'date-time' } } } } } },
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref('Charge') } } } },
        },
      },
    },
    components: { schemas: { Charge: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, when: { type: 'string', format: 'date-time' } } } } },
  };
}

/** A project with one app model and the golem-mode manifest of an SDK that has no validators of its own. */
function golemModeProject(t: TestContext, format: string) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-golem-mode-sdk-', name: 'golem-mode-sdk' });
  const doc = document(format);
  const written = stableJson(generateModelManifest(doc, PROFILE, analyzeOpenApiModels(doc, true, 'date', [...normalizeAndValidate(doc).operations]), 'golem'));
  writeModelSources(sourceRoot, {
    'sdk/model-manifest.json': written,
    'ledger.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TLedger = IModel<{ id: string; total: number }>;\n",
  });
  const manifest = validateModelManifest(JSON.parse(written));
  assert.ok(isGolemModeManifest(manifest));
  const context = { root, sources: [path.join(sourceRoot, 'ledger.model.ts')], manifestInputs: [path.join(sourceRoot, 'sdk/model-manifest.json')] };
  return { manifest, context };
}

test('the models job compiles the SDK operation roots and the app models into one validators module', t => {
  // protects: T-698 one validator set for SDK types and app models; no SDK validator is copied (E-52)
  const { manifest, context } = golemModeProject(t, 'date');
  const result = generate({ ...context, profile: { mobx: false, validation: true } });
  const { graph, valueNodes } = sdkSchemaGraph(manifest, true);
  const requestRoot = graph.nodes.get(valueNodes.get(JSON.stringify(['createCharge', 'request', 'application/json'])) ?? '')?.codecId ?? '';
  const responseRoot = graph.nodes.get(valueNodes.get(JSON.stringify(['createCharge', 'response', '200', 'application/json'])) ?? '')?.codecId ?? '';
  assert.match(requestRoot, /^Anonymous_[0-9a-f]{8}$/);
  assert.equal(responseRoot, manifest.codecIds.Charge);

  const validators = result.artifacts.filter(artifact => artifact.path.endsWith('.validators.generated.ts'));
  assert.equal(validators.length, 1);
  const exported = [...validators[0]!.content.matchAll(/^export function validate_(\w+?)(?:_wire|_model_only|_wire_only)?\(/gm)].map(match => match[1]!);
  assert.deepEqual([...new Set(exported)].map(id => id.replace(/_[0-9a-f]{8}$/, '')).sort(), ['Anonymous', 'Charge', 'TLedger']);
  for (const root of [requestRoot, responseRoot]) {
    assert.equal(validators[0]!.content.split(`export function validate_${root}(`).length - 1, 1, `${root} is compiled once`);
  }
  assert.deepEqual(result.artifacts.map(artifact => path.basename(artifact.path)).sort(), ['codec-keys.json', 'ledger.model.generated.ts', 'models.validators.generated.ts']);
});

test('the models job reports the diagnostics of the SDK types: an unknown format in an SDK operation stops generation', t => {
  // protects: T-698 SDK validator diagnostics come from the models job now that a golem-mode SDK compiles nothing
  const { context } = golemModeProject(t, 'no-such-format');
  const result = generate({ ...context, profile: { mobx: false, validation: true } });
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.diagnostics?.some(diagnostic => diagnostic.severity === GolemDiagnosticSeverity.Error && diagnostic.message.includes('no-such-format')), true, JSON.stringify(result.diagnostics));
});

test('a manifest node the rebuilt graph does not hold stops with the regenerate message', t => {
  // protects: T-698 SDK node ids of the manifest and of the models job agree, or generation says to regenerate the SDK
  const { manifest } = golemModeProject(t, 'date');
  const operations = manifest.operations.map(operation => ({ ...operation, values: operation.values.map(value => ({ ...value, node: `${value.node}_other` })) }));
  assert.throws(() => sdkSchemaGraph({ ...manifest, operations }, true), /names the schema node "Anonymous_[0-9a-f]{8}_other" for request application\/json, which this golem does not rebuild\. Regenerate the SDK with this golem version\./);
});
