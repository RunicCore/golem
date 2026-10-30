import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { identifier, render } from '#golem/code';
import { stableJson } from '#golem/generator-core';
import { isGolemModeManifest, internSdkSchemas, sdkCodecIds, validateModelManifest } from '#golem/model-manifest-core';
import { createSchemaGraph } from '#golem/schema-graph';
import { emitCodecRuntimeCode } from '#golem/stringify-emitter';
import { normalizeAndValidate } from '#openapi/document';
import { generate } from '#openapi/generator';
import { generateModelManifest } from '#openapi/model-manifest';
import { declaredModelBases } from '#openapi/model-resolution';
import { analyzeOpenApiModels } from '#openapi/model-schema-graph';
import { createFixtureProject } from '../fixture-project.js';
import { writeOpenApiDocument } from './helpers.js';

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
  const written = stableJson(generateModelManifest(DOCUMENT, PROFILE, original, 'golem'));
  const manifest = validateModelManifest(JSON.parse(written));
  assert.ok(isGolemModeManifest(manifest));
  assert.equal(Object.hasOwn(manifest, 'validationSchemaClosure'), false);
  assert.equal(manifest.dates, 'temporal');
  assert.match(manifest.descriptors.find(entry => entry.name === 'Charge')?.descriptor ?? '', /"id":"temporal:TemporalInstant"/);

  const graph = createSchemaGraph({}, { codecSource: 'openapi', codecIds: sdkCodecIds(manifest) });
  const valueNodes = internSdkSchemas(graph, manifest, true);
  graph.seal();

  assert.deepEqual([...graph.nodes.keys()], [...original.schemaGraph.nodes.keys()]);
  assert.deepEqual([...graph.nodes.values()].map(node => node.codecId), [...original.schemaGraph.nodes.values()].map(node => node.codecId));
  assert.deepEqual([...valueNodes], [...original.convertedNodeIds]);
  assert.deepEqual(graph.nodes.get('Charge')?.descriptor, original.schemaGraph.nodes.get('Charge')?.descriptor);
  const bases = declaredModelBases(original.definitions);
  assert.equal(codecText(graph, bases), codecText(original.schemaGraph, bases));
});

test('standalone mode keeps the manifest it always wrote', () => {
  // protects: T-696 standalone keeps its manifest: validation closure, no mode
  const manifest = generateModelManifest(DOCUMENT, PROFILE, analysis('date')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(manifest, 'mode'), false);
  assert.ok(Array.isArray(manifest.validationSchemaClosure));
  assert.equal(Object.hasOwn(manifest, 'descriptors'), false);
});

test('an openapi job in golem mode writes the graph into model-manifest.json', async t => {
  // protects: T-696 the job's mode key reaches the manifest
  const directory = createFixtureProject(t, 'golem-mode-manifest-');
  const input = writeOpenApiDocument(directory, DOCUMENT);
  const result = await generate({ input, output: path.join(directory, 'sdk'), name: 'Charges', profile: PROFILE, mode: 'golem' });
  const manifest = validateModelManifest(JSON.parse(result.artifacts.find(artifact => artifact.path.endsWith('/model-manifest.json'))?.content ?? '{}'));
  assert.ok(isGolemModeManifest(manifest));
  assert.deepEqual(Object.keys(manifest.codecIds), ['Cat', 'Charge', 'Tree']);
  assert.deepEqual(manifest.operations.map(operation => [operation.name, operation.values.map(value => value.at)]), [
    ['createCharge', [['parameter', 'query', 'since'], ['request', 'application/json'], ['response', '200', 'application/json']]],
  ]);
});

test('a golem-mode manifest without the graph, or with the closure, or with another mode is refused and says to regenerate', () => {
  // protects: T-696 F-253 an older manifest gets the regenerate error
  const written = JSON.parse(stableJson(generateModelManifest(DOCUMENT, PROFILE, analysis('date'), 'golem'))) as Record<string, unknown>;
  const { descriptors: _descriptors, ...withoutGraph } = written;
  assert.throws(() => validateModelManifest(withoutGraph, 'sdk/model-manifest.json'), /Invalid model manifest sdk\/model-manifest\.json: descriptors must list .* Regenerate the SDK with this golem version\./);
  assert.throws(() => validateModelManifest({ ...written, validationSchemaClosure: [] }), /not validationSchemaClosure\. Regenerate/);
  assert.throws(() => validateModelManifest({ ...written, dates: 'moment' }), /dates must be "date" or "temporal"\. Regenerate/);
  assert.throws(() => validateModelManifest({ ...written, mode: 'both' }), /mode must be "golem" when present\. Regenerate/);
  assert.throws(() => validateModelManifest({ ...written, descriptors: [{ name: 'Ghost', descriptor: '{"kind":"string"}' }] }), /schema Ghost has no codec id/);
  assert.throws(() => validateModelManifest({ ...written, descriptors: [{ name: 'Charge', descriptor: 'not json' }] }), /descriptors must list/);
});
