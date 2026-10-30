import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { identifier, render } from '#golem/code';
import { stableJson } from '#golem/generator-core';
import { isGolemModeManifest, sdkSchemaGraph, validateModelManifest } from '#golem/model-manifest-core';
import { emitCodecRuntimeCode } from '#golem/stringify-emitter';
import { normalizeAndValidate } from '#openapi/document';
import { generate } from '#openapi/generator';
import { generateModelManifest } from '#openapi/model-manifest';
import { declaredModelBases } from '#openapi/model-resolution';
import { analyzeOpenApiModels } from '#openapi/model-schema-graph';
import { createFixtureProject } from '../fixture-project.js';
import { golemModeManifest, writeOpenApiDocument } from './helpers.js';

const PROFILE = { mobx: false, validation: true, allowAny: false } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Charges', version: '1' },
  paths: {
    '/charges': {
      post: {
        operationId: 'createCharge',
        parameters: [{ name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { when: { type: 'string', format: 'date-time' }, note: { type: 'string' } } } } } },
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref('Charge') } } } },
      },
    },
  },
  components: {
    schemas: {
      Charge: { type: 'object', required: ['id', 'when'], properties: { id: { type: 'string' }, when: { type: 'string', format: 'date-time' }, next: ref('Tree') } },
      Tree: { oneOf: [{ type: 'string' }, { type: 'array', items: ref('Tree') }] },
      Cat: { type: 'object', required: ['kind'], properties: { kind: { const: 'cat' }, born: { type: 'string', format: 'date' } } },
    },
  },
};

function analysis(dates: 'date' | 'temporal') {
  const ir = normalizeAndValidate(DOCUMENT);
  return analyzeOpenApiModels(DOCUMENT, true, dates, [...ir.operations]);
}

/** The codec text of a graph, with each validator named after its node. */
const codecText = (graph: Parameters<typeof emitCodecRuntimeCode>[0], bases: ReturnType<typeof declaredModelBases>) =>
  render(emitCodecRuntimeCode(graph, { modelBases: bases, exportAnonymousCodecs: true, validatorName: (id) => identifier(`validate_${id.replace(/\W/g, '_')}`) }));

test('the golem-mode schema graph goes through the manifest file and back to the same nodes, references and codec text', () => {
  // protects: T-696 the models job compiles SDK types from the manifest with no loss ("it's openapi to sdk, i don't see why it can't go back to json")
  const original = analysis('temporal');
  const written = stableJson(golemModeManifest(DOCUMENT, PROFILE, 'temporal'));
  const manifest = validateModelManifest(JSON.parse(written));
  assert.ok(isGolemModeManifest(manifest));
  assert.equal(manifest.dates, 'temporal');
  assert.match(manifest.components.find(entry => entry.name === 'Charge')?.descriptor ?? '', /"id":"temporal:TemporalInstant"/);

  const { graph, valueNodes } = sdkSchemaGraph(manifest, true);

  assert.deepEqual([...graph.nodes.keys()], [...original.schemaGraph.nodes.keys()]);
  assert.deepEqual([...graph.nodes.values()].map(node => node.codecId), [...original.schemaGraph.nodes.values()].map(node => node.codecId));
  assert.deepEqual([...valueNodes], [...original.convertedNodeIds]);
  assert.deepEqual(graph.nodes.get('Charge')?.descriptor, original.schemaGraph.nodes.get('Charge')?.descriptor);
  const bases = declaredModelBases(original.definitions);
  assert.equal(codecText(graph, bases), codecText(original.schemaGraph, bases));
});

test('the golem-mode manifest lists each component once: a model by its declared type, a scalar alias by its type', () => {
  // protects: T-733 one components list holds the codec id, descriptor and type of each schema
  const document = { ...DOCUMENT, components: { schemas: { ...DOCUMENT.components.schemas, Currency: { type: 'string', maxLength: 3 } } } };
  const manifest = validateModelManifest(JSON.parse(stableJson(golemModeManifest(document, PROFILE))));
  assert.ok(isGolemModeManifest(manifest));
  assert.deepEqual(manifest.components.map(entry => [entry.name, entry.codecId !== undefined, entry.type?.export]), [
    ['Charge', true, undefined], ['Cat', true, undefined], ['Tree', true, undefined], ['Currency', false, 'Currency'],
  ]);
  assert.deepEqual(manifest.components.find(entry => entry.name === 'Currency')?.descriptor, '{"kind":"string","constraints":[{"kind":"maxLength","value":3}]}');
  assert.deepEqual(manifest.models.map(entry => entry.type.export), ['Charge', 'Cat']);
});

test('standalone mode keeps the manifest it always wrote', () => {
  // protects: T-696 standalone keeps its manifest: validation closure, no mode
  const manifest = generateModelManifest(DOCUMENT, PROFILE, analysis('date')) as Record<string, unknown>;
  assert.equal(isGolemModeManifest(validateModelManifest(JSON.parse(stableJson(manifest)))), false);
});

test('an openapi job in golem mode writes the graph into model-manifest.json', async t => {
  // protects: T-696 the job's mode key reaches the manifest
  const directory = createFixtureProject(t, 'golem-mode-manifest-');
  const input = writeOpenApiDocument(directory, DOCUMENT);
  const result = await generate({ input, output: path.join(directory, 'sdk'), name: 'Charges', profile: PROFILE, mode: 'golem', codecsFile: path.join(directory, 'models/sdk.sdk.generated.ts') });
  const manifest = validateModelManifest(JSON.parse(result.artifacts.find(artifact => artifact.path.endsWith('/model-manifest.json'))?.content ?? '{}'));
  assert.ok(isGolemModeManifest(manifest));
  assert.deepEqual(manifest.components.flatMap(entry => entry.codecId === undefined ? [] : [entry.name]), ['Charge', 'Cat', 'Tree']);
  assert.deepEqual(manifest.operations.map(operation => [operation.name, operation.values.map(value => value.at)]), [
    ['createCharge', [['parameter', 'query', 'since'], ['request', 'application/json'], ['response', '200', 'application/json']]],
  ]);
  // protects: T-699 the manifest carries the validation roots the models job compiles, and the schemas they reach once
  const validation = manifest.operations[0]?.validation;
  assert.deepEqual([validation?.input, validation?.headers, validation?.responses.map(item => item.key), Object.keys(validation?.roots ?? {})], [
    'createCharge:input', undefined, ['200:application/json'], ['createCharge:input', 'createCharge:response:200:application/json'],
  ]);
  assert.equal(Object.keys(manifest.validationResources ?? {}).some(id => id.endsWith(':operation:createCharge')), true);
});

test('a golem-mode manifest without the graph, or with another mode is refused and says to regenerate', () => {
  // protects: T-696 F-253 an older manifest gets the regenerate error
  const written = JSON.parse(stableJson(golemModeManifest(DOCUMENT, PROFILE))) as Record<string, unknown>;
  const { components: _components, ...withoutGraph } = written;
  assert.throws(() => validateModelManifest(withoutGraph, 'sdk/model-manifest.json'), /Invalid model manifest sdk\/model-manifest\.json: components must list .* Regenerate the SDK with this golem version\./);
  // The shape before the components list is refused the same way.
  assert.throws(() => validateModelManifest({ ...withoutGraph, codecIds: {}, descriptors: [] }), /components must list .* Regenerate the SDK with this golem version\./);
  assert.throws(() => validateModelManifest({ ...written, dates: 'moment' }), /dates must be "date" or "temporal"\. Regenerate/);
  assert.throws(() => validateModelManifest({ ...written, validationResources: undefined }), /a validating SDK lists the validation roots of every operation and the resources they reach, and a non-validating SDK lists none\. Regenerate/);
  assert.throws(() => validateModelManifest({ ...written, mode: 'both' }), /mode must be "golem" when present\. Regenerate/);
  assert.throws(() => validateModelManifest({ ...written, components: [{ name: 'Ghost', descriptor: '{"kind":"string"}' }] }), /components must list .* a codec id for a graph node and the type of a scalar alias/);
  assert.throws(() => validateModelManifest({ ...written, components: [{ name: 'Charge', codecId: 'Charge_00000001', descriptor: 'not json' }] }), /components must list/);
  const withoutCharge = (written.components as { name: string }[]).filter(component => component.name !== 'Charge');
  assert.throws(() => validateModelManifest({ ...written, components: withoutCharge }), /model entry Charge has no codecId\. Regenerate/);
});
