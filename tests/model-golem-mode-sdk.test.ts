import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import { stableJson } from '#golem/generator-core';
import { isGolemModeManifest, sdkSchemaGraph, validateModelManifest } from '#golem/model-manifest-core';
import { generate } from '#model/generator';
import { golemModeManifest } from './openapi/helpers.js';
import { createModelProject, writeModelSources } from './model-project.js';

const PROFILE = { mobx: false, validation: true, allowAny: false } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function document(format: string, chargeExtra: Record<string, unknown> = {}) {
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
    components: { schemas: { Charge: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, when: { type: 'string', format: 'date-time' }, ...chargeExtra } } } },
  };
}

/** A project with one app model and the golem-mode manifest of an SDK that has no validators of its own. */
function golemModeProject(t: TestContext, format: string) {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-golem-mode-sdk-', name: 'golem-mode-sdk' });
  const doc = document(format);
  const written = stableJson(golemModeManifest(doc, PROFILE));
  writeModelSources(sourceRoot, {
    'sdk/model-manifest.json': written,
    'ledger.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TLedger = IModel<{ id: string; total: number }>;\n",
  });
  const manifest = validateModelManifest(JSON.parse(written));
  assert.ok(isGolemModeManifest(manifest));
  const context = { root, sources: [path.join(sourceRoot, 'ledger.model.ts')], manifestInputs: [path.join(sourceRoot, 'sdk/model-manifest.json')], sdkOutputs: [path.join(sourceRoot, 'sdk')] };
  return { manifest, context };
}

test('the models job compiles the SDK operation roots and the app models into one validators module', t => {
  // protects: T-698 T-699 one validator set for SDK types, SDK operations and app models; no SDK validator is copied (E-52)
  const { manifest, context } = golemModeProject(t, 'date');
  const result = generate({ ...context, profile: { mobx: false, validation: true } });
  const { graph, valueNodes } = sdkSchemaGraph(manifest, true);
  const requestRoot = graph.nodes.get(valueNodes.get(JSON.stringify(['createCharge', 'request', 'application/json'])) ?? '')?.codecId ?? '';
  const responseRoot = graph.nodes.get(valueNodes.get(JSON.stringify(['createCharge', 'response', '200', 'application/json'])) ?? '')?.codecId ?? '';
  assert.match(requestRoot, /^Anonymous_[0-9a-f]{8}$/);
  assert.equal(responseRoot, manifest.codecIds.Charge);

  const validators = result.artifacts.filter(artifact => artifact.path.endsWith('.validators.generated.ts'));
  assert.equal(validators.length, 1);
  const source = validators[0]!.content;
  const exported = [...source.matchAll(/^export function validate_(\w+?)(?:_wire|_model_only|_wire_only)?\(/gm)].map(match => match[1]!);
  assert.deepEqual([...new Set(exported)].map(id => id.replace(/_[0-9a-f]{8}$/, '')).sort(), ['Anonymous', 'Charge', 'TLedger', 'src_sdk_createCharge_input', 'src_sdk_createCharge_response_200_application_json']);
  for (const root of [requestRoot, responseRoot]) {
    assert.equal(source.split(`export function validate_${root}(`).length - 1, 1, `${root} is compiled once`);
  }
  // The operation's response root is the model's wire check, not a second function for the same schema.
  assert.equal(source.match(/^function f\d+_Charge_[0-9a-f]{8}(?:_wire)?\(/gm)?.length, 2, 'one model check and one wire check of Charge');
  assert.match(source, /export function validate_src_sdk_createCharge_response_200_application_json\(.*\n.*\n  f\d+_Charge_[0-9a-f]{8}_wire\(/);
  assert.deepEqual(result.artifacts.map(artifact => path.basename(artifact.path)).sort(), ['codec-keys.json', 'ledger.model.generated.ts', 'models.validators.generated.ts', 'sdk.sdk.generated.ts']);
});

test('the models job writes the sdkCodecs table: a member per operation in the shape of a standalone codec module', t => {
  // protects: T-699 the file sdkCodecsFile names exports sdkCodecs, one member per operation, with the SDK node codecs it names
  const { manifest, context } = golemModeProject(t, 'date');
  const result = generate({ ...context, profile: { mobx: false, validation: true } });
  const file = result.artifacts.find(artifact => artifact.path === path.join(context.root, 'src/generated/models/src/sdk.sdk.generated.ts'));
  const { graph, valueNodes } = sdkSchemaGraph(manifest, true);
  const requestNode = valueNodes.get(JSON.stringify(['createCharge', 'request', 'application/json'])) ?? '';
  assert.ok(graph.nodes.has(requestNode));
  const table = file?.content.slice(file.content.indexOf('export const sdkCodecs')) ?? '';
  assert.equal(table, `export const sdkCodecs = {
  createCharge: {
    input: validate_src_sdk_createCharge_input,
    responses: {
      "200:application/json": validate_src_sdk_createCharge_response_200_application_json,
    },
    encode: {
      "application/json": toWireFormat${requestNode},
    },
    decode: {
      "200:application/json": fromWireFormatCharge,
    },
  },
} as const;
`);
  assert.match(file?.content ?? '', /^import \{ .*validate_src_sdk_createCharge_input.* \} from '\.\.\/models\.validators\.generated\.js';$/m);
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

test('two golem-mode SDKs with one operation name compile to separate roots in the one validators module', t => {
  // protects: T-699 root and export names carry the SDK scope, so SDKs with the same operation name do not collide
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-model-two-sdks-', name: 'two-sdks' });
  writeModelSources(sourceRoot, {
    'first/model-manifest.json': stableJson(golemModeManifest(document('date'), PROFILE)),
    'second/model-manifest.json': stableJson(golemModeManifest(document('date', { amount: { type: 'number' } }), PROFILE)),
    'ledger.model.ts': "import type { IModel } from '@exprtlabs/golem/model';\nexport type TLedger = IModel<{ id: string; total: number }>;\n",
  });
  const result = generate({
    root,
    sources: [path.join(sourceRoot, 'ledger.model.ts')],
    manifestInputs: ['first', 'second'].map(folder => path.join(sourceRoot, folder, 'model-manifest.json')),
    sdkOutputs: ['first', 'second'].map(folder => path.join(sourceRoot, folder)),
    profile: { mobx: false, validation: true },
  });
  const source = result.artifacts.find(artifact => artifact.path.endsWith('.validators.generated.ts'))?.content ?? '';
  const operationRoots = [...source.matchAll(/^export function validate_(src_\w+)\(/gm)].map(match => match[1]!);
  assert.deepEqual(operationRoots, [
    'src_first_createCharge_input', 'src_first_createCharge_response_200_application_json',
    'src_second_createCharge_input', 'src_second_createCharge_response_200_application_json',
  ]);
  assert.equal(new Set(source.match(/^export function validate_Charge_[0-9a-f]{8}\(/gm)).size, 2, 'the two Charge shapes have two codec ids');
});

test('a golem-mode manifest that no openapi job of the golem.yaml writes is refused', t => {
  // protects: T-699 the models job takes the codecs file from the config and never from where a manifest lies
  const { context } = golemModeProject(t, 'date');
  assert.throws(() => generate({ ...context, sdkOutputs: [], profile: { mobx: false, validation: true } }), /is in mode golem, but no openapi job of mode golem in this golem\.yaml writes its folder/);
});
