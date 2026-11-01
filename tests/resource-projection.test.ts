import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFixture } from './fixture-project.js';
import { generate } from '#openapi/generator';
import { buildSchemaData } from '#openapi/schemas';
import {
  compileGeneratedSdk,
  materializeGeneratedSdk,
  requireRecord,
} from './openapi/helpers.js';

/** The registries every SDK's operation schemas are built from. */
function schemaRegistries(document: unknown): Record<string, unknown> {
  const data = buildSchemaData(document);
  return { schemaRegistry: data.registry, runtimeSchemaRegistry: data.normalizedRegistry };
}

const literalDefault = {
  $id: 'literal-default-id',
  $ref: '#/components/schemas/Envelope',
  marker: 'default-data',
};
const literalExample = {
  $id: 'literal-example-id',
  $ref: '#/components/schemas/Envelope',
  marker: 'example-data',
};
const literalConst = {
  $id: 'literal-const-id',
  $ref: '#/components/schemas/Envelope',
  marker: 'const-data',
};
const literalEnum = {
  $id: 'literal-enum-id',
  $ref: '#/components/schemas/Envelope',
  marker: 'enum-data',
};

function projectionDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Resource Projection', version: '1' },
    paths: {
      // An absolute URN reference at the operation level resolves to the
      // embedded resource declared by its $id.
      '/value': {
        get: {
          operationId: 'getValue',
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: 'urn:fixture:embedded' } },
              },
            },
          },
        },
      },
      '/trees/{id}': {
        post: {
          operationId: 'saveTree',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Envelope' } },
            },
          },
          responses: {
            200: {
              description: 'saved tree',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Envelope' } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Envelope: {
          type: 'object',
          additionalProperties: false,
          required: ['root', 'embedded', 'anchored', 'treeAlias', 'literal'],
          properties: {
            root: { $ref: '#/components/schemas/Tree' },
            embedded: { $ref: '#/components/schemas/Embedded' },
            anchored: { $ref: '#/components/schemas/Anchored' },
            // Component references inside a projected resource must resolve to
            // the directional copy, including recursive references.
            treeAlias: { $ref: '#/components/schemas/Tree' },
            clientSecret: { type: 'string', writeOnly: true },
            serverValue: { type: 'string', readOnly: true },
            literal: {
              type: 'object',
              additionalProperties: false,
              properties: {
                defaultValue: { default: literalDefault },
                exampleValue: { examples: [literalExample] },
                constValue: { const: literalConst },
                enumValue: { enum: [literalEnum] },
              },
            },
          },
        },
        Tree: {
          $id: 'urn:fixture:tree',
          type: 'object',
          additionalProperties: false,
          required: ['value', 'serverValue'],
          properties: {
            value: { type: 'string' },
            serverValue: { type: 'string', readOnly: true },
            children: {
              type: 'array',
              items: { $ref: '#/components/schemas/Tree' },
            },
          },
        },
        Child: {
          $id: 'urn:fixture:child',
          type: 'object',
          additionalProperties: false,
          required: ['value', 'serverValue'],
          properties: {
            value: { type: 'integer' },
            serverValue: { type: 'string', readOnly: true },
          },
        },
        Embedded: {
          $id: 'urn:fixture:embedded',
          type: 'object',
          additionalProperties: false,
          required: ['code', 'child'],
          properties: {
            code: { type: 'string' },
            // This component reference must resolve to the directional Child
            // resource so its readOnly requirement follows the direction.
            child: { $ref: '#/components/schemas/Child' },
          },
        },
        Anchored: {
          $id: 'urn:fixture:anchored',
          $anchor: 'entry',
          type: 'object',
          additionalProperties: false,
          required: ['name', 'serverValue'],
          properties: {
            name: { type: 'string' },
            serverValue: { type: 'string', readOnly: true },
            // The local anchor remains in the nested Anchored resource scope.
            again: { $ref: '#entry' },
          },
        },
      },
    },
  };
}

const graphWholeId = 'https://schemas.example.test/api/v1/graph/whole';
const graphLeafId = 'https://schemas.example.test/api/v1/graph/parts/leaf';
const graphNestedId = 'https://schemas.example.test/api/v1/graph/parts/nested';

function resourceGraphDocument(): Record<string, unknown> {
  const wholeReference = { $ref: graphWholeId };
  const scoreReference = { $ref: `${graphWholeId}#/properties/score` };
  const nestedReference = { $ref: `${graphWholeId}#/properties/nested` };
  return {
    openapi: '3.1.0',
    info: { title: 'Resource Graph', version: '1' },
    paths: {
      '/graph/whole': {
        get: {
          operationId: 'getWhole',
          responses: {
            200: {
              description: 'whole graph resource',
              content: { 'application/json': { schema: wholeReference } },
            },
          },
        },
      },
      '/graph/score': {
        get: {
          operationId: 'getScore',
          responses: {
            200: {
              description: 'exact scalar property target',
              content: { 'application/json': { schema: scoreReference } },
            },
          },
        },
      },
      '/graph/nested': {
        get: {
          operationId: 'getNested',
          responses: {
            200: {
              description: 'exact nested property target',
              content: { 'application/json': { schema: nestedReference } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        GraphWhole: {
          $id: graphWholeId,
          type: 'object',
          additionalProperties: false,
          required: ['score', 'nested', 'leaf'],
          properties: {
            score: { type: 'integer' },
            // This nested resource uses a relative $id against the absolute
            // GraphWhole base and has a directory scope of its own.
            nested: {
              $id: 'parts/nested',
              type: 'object',
              additionalProperties: false,
              required: ['name'],
              properties: { name: { type: 'string' } },
            },
            leaf: { $ref: graphLeafId },
          },
        },
        GraphLeaf: {
          $id: graphLeafId,
          type: 'object',
          additionalProperties: false,
          required: ['label'],
          properties: { label: { type: 'string' } },
        },
      },
    },
  };
}

function writeResourceGraphConsumer(output: string): string {
  const consumer = path.join(output, 'resource-graph-consumer.ts');
  writeFileSync(consumer, readFixture('models/resource-projection/resource-graph-consumer.ts'));
  return consumer;
}

function writeConsumer(output: string): string {
  const consumer = path.join(output, 'consumer.ts');
  writeFileSync(consumer, readFixture('models/resource-projection/directional-resource-consumer.ts'));
  return consumer;
}

function resourceSchemas(registry: unknown, resourceName: string): Record<string, unknown> {
  const root = requireRecord(registry, 'runtime schema registry');
  const defs = requireRecord(root.$defs, 'runtime schema resources');
  const resource = requireRecord(defs[resourceName], resourceName);
  const components = requireRecord(resource.components, `${resourceName}.components`);
  return requireRecord(components.schemas, `${resourceName}.components.schemas`);
}

function resourceDefinitions(registry: unknown, resourceName: string): Record<string, unknown> {
  const root = requireRecord(registry, 'runtime schema registry');
  const defs = requireRecord(root.$defs, 'runtime schema resources');
  const resource = requireRecord(defs[resourceName], resourceName);
  return requireRecord(resource.$defs, `${resourceName}.$defs`);
}

function projectedSchema(
  registry: unknown,
  resourceName: string,
  schemas: Record<string, unknown>,
  name: string,
  canonical: string,
): Record<string, unknown> {
  const component = requireRecord(schemas[name], `${resourceName}.${name}`);
  if (typeof component.$id === 'string') return component;
  const definitions = resourceDefinitions(registry, resourceName);
  return requireRecord(definitions[canonical], `${resourceName}.$defs.${canonical}`);
}

function schemaProperties(schema: unknown, label: string): Record<string, unknown> {
  return requireRecord(requireRecord(schema, label).properties, `${label}.properties`);
}

/** Compiles the consumer in a strict program over the materialized SDK, then runs its built `script` and expects exit 0. */
function runStrictConsumer(output: string, consumer: string, script: string): void {
  compileGeneratedSdk(output, [consumer], {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: true,
    outDir: path.join(output, 'build'),
  });
  const execution = spawnSync(process.execPath, [path.join(output, 'build', script)], {
    encoding: 'utf8',
  });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
}

test('public directional resources preserve nested scopes and run through generated validators in strict consumers', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'golem-resource-projection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'openapi.json');
  const output = path.join(root, 'sdk');
  writeFileSync(input, `${JSON.stringify(projectionDocument(), null, 2)}\n`);
  const result = await generate({
    input,
    output,
    name: 'ResourceProjection',
    profile: { validation: true },
  });
  assert.deepEqual(result.diagnostics ?? [], []);
  assert.equal(result.artifacts.every(({ path: filename }) => path.isAbsolute(filename)), true);
  assert.equal(existsSync(output), false, 'public generation must stay pure until materialization');

  materializeGeneratedSdk(result.artifacts, output);
  const consumer = writeConsumer(output);
  runStrictConsumer(output, consumer, 'consumer.js');

  const schemasModule = schemaRegistries(projectionDocument());
  const runtimeRegistry = requireRecord(schemasModule.runtimeSchemaRegistry, 'runtime schema registry');
  const inputSchemas = resourceSchemas(runtimeRegistry, 'golem-input');
  const outputSchemas = resourceSchemas(runtimeRegistry, 'golem-output');
  const neutralRegistry = requireRecord(schemasModule.schemaRegistry, 'neutral schema registry');
  const neutralComponents = requireRecord(neutralRegistry.components, 'neutral schema components');
  const neutralSchemas = requireRecord(neutralComponents.schemas, 'neutral component schemas');
  const inputEnvelope = requireRecord(inputSchemas.Envelope, 'input Envelope');
  const outputEnvelope = requireRecord(outputSchemas.Envelope, 'output Envelope');
  const inputEnvelopeProperties = schemaProperties(inputEnvelope, 'input Envelope');
  const outputEnvelopeProperties = schemaProperties(outputEnvelope, 'output Envelope');
  const inputTree = projectedSchema(runtimeRegistry, 'golem-input', inputSchemas, 'Tree', 'urn:fixture:tree');
  const outputTree = projectedSchema(runtimeRegistry, 'golem-output', outputSchemas, 'Tree', 'urn:fixture:tree');
  const inputEmbedded = projectedSchema(runtimeRegistry, 'golem-input', inputSchemas, 'Embedded', 'urn:fixture:embedded');
  const outputEmbedded = projectedSchema(runtimeRegistry, 'golem-output', outputSchemas, 'Embedded', 'urn:fixture:embedded');
  const inputChild = projectedSchema(runtimeRegistry, 'golem-input', inputSchemas, 'Child', 'urn:fixture:child');
  const outputChild = projectedSchema(runtimeRegistry, 'golem-output', outputSchemas, 'Child', 'urn:fixture:child');
  const inputAnchored = projectedSchema(runtimeRegistry, 'golem-input', inputSchemas, 'Anchored', 'urn:fixture:anchored');
  const outputAnchored = projectedSchema(runtimeRegistry, 'golem-output', outputSchemas, 'Anchored', 'urn:fixture:anchored');

  assert.equal(requireRecord(neutralSchemas.Tree, 'neutral Tree').$id, 'urn:fixture:tree');
  assert.equal(requireRecord(neutralSchemas.Embedded, 'neutral Embedded').$id, 'urn:fixture:embedded');
  assert.equal(requireRecord(neutralSchemas.Child, 'neutral Child').$id, 'urn:fixture:child');
  assert.equal(requireRecord(inputTree, 'input Tree').$id, 'urn:fixture:tree:input');
  assert.equal(requireRecord(outputTree, 'output Tree').$id, 'urn:fixture:tree:output');
  assert.equal(requireRecord(inputEmbedded, 'input Embedded').$id, 'urn:fixture:embedded:input');
  assert.equal(requireRecord(outputEmbedded, 'output Embedded').$id, 'urn:fixture:embedded:output');
  assert.equal(requireRecord(inputChild, 'input Child').$id, 'urn:fixture:child:input');
  assert.equal(requireRecord(outputChild, 'output Child').$id, 'urn:fixture:child:output');
  assert.equal(requireRecord(inputAnchored, 'input Anchored').$id, 'urn:fixture:anchored:input');
  assert.equal(requireRecord(outputAnchored, 'output Anchored').$id, 'urn:fixture:anchored:output');
  assert.equal('serverValue' in inputEnvelopeProperties, false);
  assert.equal('clientSecret' in outputEnvelopeProperties, false);

  const inputLiteral = schemaProperties(
    schemaProperties(inputSchemas.Envelope, 'input Envelope').literal,
    'input Envelope.literal',
  );
  const outputLiteral = schemaProperties(
    schemaProperties(outputSchemas.Envelope, 'output Envelope').literal,
    'output Envelope.literal',
  );
  assert.deepEqual(requireRecord(inputLiteral.defaultValue, 'input defaultValue').default, literalDefault);
  assert.deepEqual(requireRecord(inputLiteral.exampleValue, 'input exampleValue').examples, [literalExample]);
  assert.deepEqual(requireRecord(inputLiteral.constValue, 'input constValue').const, literalConst);
  assert.deepEqual(requireRecord(inputLiteral.enumValue, 'input enumValue').enum, [literalEnum]);
  assert.deepEqual(requireRecord(outputLiteral.defaultValue, 'output defaultValue').default, literalDefault);
  assert.deepEqual(requireRecord(outputLiteral.exampleValue, 'output exampleValue').examples, [literalExample]);
  assert.deepEqual(requireRecord(outputLiteral.constValue, 'output constValue').const, literalConst);
  assert.deepEqual(requireRecord(outputLiteral.enumValue, 'output enumValue').enum, [literalEnum]);
});

test('public resource graph distinguishes whole, scalar, and nested targets with relative resource scope', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'golem-resource-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'openapi.json');
  const output = path.join(root, 'sdk');
  writeFileSync(input, `${JSON.stringify(resourceGraphDocument(), null, 2)}\n`);

  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (..._args: Parameters<typeof fetch>) => {
    fetched = true;
    throw new Error('resource graph unexpectedly fetched a URL');
  };
  let result: Awaited<ReturnType<typeof generate>>;
  try {
    result = await generate({
      input,
      output,
      name: 'ResourceGraph',
      profile: { validation: true },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetched, false);
  assert.equal(existsSync(output), false, 'public generation must stay pure until materialization');

  materializeGeneratedSdk(result.artifacts, output);
  const consumer = writeResourceGraphConsumer(output);
  runStrictConsumer(output, consumer, 'resource-graph-consumer.js');

  const schemasModule = schemaRegistries(resourceGraphDocument());
  const neutralRegistry = requireRecord(schemasModule.schemaRegistry, 'graph neutral schema registry');
  const neutralComponents = requireRecord(neutralRegistry.components, 'graph neutral components');
  const neutralSchemas = requireRecord(neutralComponents.schemas, 'graph neutral schemas');
  assert.equal(requireRecord(neutralSchemas.GraphWhole, 'graph neutral whole').$id, graphWholeId);
  assert.equal(requireRecord(neutralSchemas.GraphLeaf, 'graph neutral leaf').$id, graphLeafId);

  const runtimeRegistry = requireRecord(schemasModule.runtimeSchemaRegistry, 'graph runtime schema registry');
  const outputSchemas = resourceSchemas(runtimeRegistry, 'golem-output');
  const outputWhole = projectedSchema(runtimeRegistry, 'golem-output', outputSchemas, 'GraphWhole', graphWholeId);
  assert.equal(requireRecord(outputWhole, 'graph output whole').$id, `${graphWholeId}:output`);
  const outputDefinitions = resourceDefinitions(runtimeRegistry, 'golem-output');
  const outputNested = requireRecord(outputDefinitions[graphNestedId], 'graph output nested resource');
  assert.equal(outputNested.$id, `${graphNestedId}:output`);
  const outputLeaf = requireRecord(outputDefinitions[graphLeafId], 'graph output leaf resource');
  assert.equal(outputLeaf.$id, `${graphLeafId}:output`);
});
