import { reachesRecursiveNode } from '@exprtlabs/golem/internal/emitter';
import type { SchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import type { CodecSchemaClosureEntry } from '@exprtlabs/golem/internal/validation-plan';
import type { JsonSchema } from '@exprtlabs/golem/internal/schema';
import { sourceDigest } from '@exprtlabs/golem/internal/generator-support';
import { asRecord, isJsonObject } from './json.js';
import { compareText } from '@exprtlabs/golem/generator-api';
import type { GolemModeManifest, SdkOperationValue } from '@exprtlabs/golem/manifest';
import { GENERATOR_NAME, PACKAGE_VERSION } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import {
  type ModelDefinition,
  type OpenApiModelAnalysis,
  modelStableId,
} from './model-resolution.js';

/**
 * The schema graph the models job compiles in golem mode: each model and recursive alias with its codec id, and the operations' values.
 * Descriptors are JSON text (see `SdkDescriptorText`). The data is the graph's inputs, so interning it again with these codec ids
 * gives the same nodes. A value of a `$ref` is the node of that model and holds no descriptor.
 */
function golemModeGraph(analysis: OpenApiModelAnalysis): Pick<GolemModeManifest, 'mode' | 'dates' | 'codecIds' | 'descriptors' | 'operations'> {
  const operations: { name: string; values: SdkOperationValue[] }[] = [];
  for (const [key, node] of analysis.convertedNodeIds) {
    const [name, ...at] = JSON.parse(key) as [string, ...string[]];
    const input = analysis.graphInputs.values.get(key);
    const inline = input && { ...(input.name === undefined ? {} : { name: input.name }), descriptor: JSON.stringify(input.descriptor) };
    const last = operations.at(-1);
    const values = last?.name === name ? last.values : operations[operations.push({ name, values: [] }) - 1]!.values;
    values.push({ at, node, ...(inline ? { inline } : {}) });
  }
  return {
    mode: 'golem',
    dates: analysis.dates,
    codecIds: Object.fromEntries(analysis.graphInputs.models.map(({ name }) => [name, openApiCodecId(analysis, name)])),
    descriptors: analysis.graphInputs.models.map(({ name, descriptor }) => ({ name, descriptor: JSON.stringify(descriptor) })),
    operations,
  };
}

/** `golem` mode writes the schema graph in place of the data-only validation closure; `standalone` keeps the closure. */
export function generateModelManifest(
  document: unknown,
  profile: OpenApiGenerationProfile,
  modelAnalysis: OpenApiModelAnalysis,
  mode: 'standalone' | 'golem' = 'standalone',
): unknown {
  profile = requireProfile(profile);
  const { ordered, schemaGraph } = modelAnalysis;
  const digest = sourceDigest(document);
  const stableId = (definition: ModelDefinition) => modelStableId(digest, definition);
  const byName = modelAnalysis.definitions;
  const models = ordered.map((definition) => {
    const fields = [...definition.properties.keys()].map((name) => ({
      name,
      required: definition.required.has(name),
    }));
    const base = definition.baseName ? byName.get(definition.baseName) : undefined;
    return {
      id: stableId(definition),
      codecId: openApiCodecId(modelAnalysis, definition.name),
      sourceKind: 'openapi',
      allowAny: profile.allowAny ?? false,
      type: {
        module: './types.ts',
        export: definition.name,
        aliases: [{ module: './index.ts', export: definition.name }],
      },
      fields,
      inheritance: base ? { baseModelId: stableId(base) } : null,
      discriminator: definition.discriminator || null,
      variants: definition.variants || [],
    };
  });
  return {
    generator: {
      name: GENERATOR_NAME,
      version: PACKAGE_VERSION,
    },
    runtime: { name: '@exprtlabs/golem', minimumVersion: PACKAGE_VERSION },
    source: {
      kind: 'openapi',
      dialect: asRecord(document).openapi,
      digest,
    },
    profile,
    models,
    ...(mode === 'golem' ? golemModeGraph(modelAnalysis) : profile.validation ? {
      validationSchemaClosure: openApiValidationSchemaClosure(schemaGraph, ordered, stableId),
    } : {}),
  };
}

export function openApiValidationSchemaClosure(
  schemaGraph: SchemaGraph,
  definitions: readonly ModelDefinition[],
  stableId: (definition: ModelDefinition) => string,
): CodecSchemaClosureEntry[] {
  const idsByName = new Map(definitions.map((definition) => [definition.name, stableId(definition)]));
  const nodesByCodecId = new Map([...schemaGraph.nodes.values()].map((node) => [node.codecId, node]));
  const compact = (value: unknown, wire: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item) => compact(item, wire));
    if (value === null || typeof value !== 'object') return value;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$defs' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        const definitions = Object.create(null) as Record<string, unknown>;
        for (const [name, schema] of Object.entries(child)) {
          const node = nodesByCodecId.get(name);
          definitions[name] = node
            ? { $ref: wire && !node.sameSchema ? `${node.codecId}#wire` : node.codecId }
            : compact(schema, wire);
        }
        result[key] = definitions;
      } else {
        result[key] = compact(child, wire);
      }
    }
    return result;
  };
  const asJsonSchema = (value: unknown): JsonSchema => {
    if (typeof value === 'boolean' || isJsonObject(value)) return value;
    throw new TypeError('Generated OpenAPI codec schema must be a JSON Schema object or boolean.');
  };
  return [...schemaGraph.nodes.values()]
    .filter((node) => node.kind !== 'reference')
    .sort((left, right) => compareText(left.codecId, right.codecId))
    .map((node) => ({
      codecId: node.codecId,
      modelSchema: asJsonSchema(compact(node.modelJsonSchema ?? node.jsonSchema, false)),
      ...(node.sameSchema ? {} : { wireSchema: asJsonSchema(compact(node.jsonSchema, true)) }),
      ...(node.modelOnlyJsonSchema === undefined ? {} : { modelOnlySchema: asJsonSchema(compact(node.modelOnlyJsonSchema, false)) }),
      ...(node.wireOnlyJsonSchema === undefined ? {} : { wireOnlySchema: asJsonSchema(compact(node.wireOnlyJsonSchema, true)) }),
      recursive: reachesRecursiveNode(schemaGraph, node),
      aliases: [...new Set([
        node.id,
        node.name,
        node.codecId,
        idsByName.get(node.name),
      ].filter((alias): alias is string => Boolean(alias)))],
    }));
}

/** The runtime codec id of a model: what the manifest records and a rewrite stamps. */
function openApiCodecId(analysis: OpenApiModelAnalysis, name: string): string {
  const node = analysis.nodesByName.get(name);
  if (!node) throw new Error(`Internal error: no schema node for model "${name}".`);
  return node.codecId;
}
