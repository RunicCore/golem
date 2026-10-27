import { reachesRecursiveNode, render } from '@exprtlabs/golem/internal/emitter';
import { codecPublicId, type SchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import type { CodecSchemaClosureEntry } from '@exprtlabs/golem/internal/validation-plan';
import type { JsonSchema } from '@exprtlabs/golem/internal/schema';
import { sourceDigest } from '@exprtlabs/golem/manifest';
import { asRecord, isJsonObject } from './json.js';
import { compareText } from '@exprtlabs/golem/generator-api';
import { GENERATOR_NAME, PACKAGE_VERSION } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import { schemaContext } from './types.js';
import {
  type ModelDefinition,
  type OpenApiModelAnalysis,
  modelEnv,
  modelStableId,
  withSchemaBase,
  modelSchemaReference,
  modelFieldType,
} from './model-resolution.js';

export function generateModelManifest(
  document: unknown,
  profile: OpenApiGenerationProfile,
  modelAnalysis: OpenApiModelAnalysis,
): unknown {
  profile = requireProfile(profile);
  const { ordered, schemaGraph } = modelAnalysis;
  const digest = sourceDigest(document);
  const stableId = (definition: ModelDefinition) => modelStableId(digest, definition);
  const byName = modelAnalysis.definitions;
  const sharedSchemaContext = schemaContext(document, { resources: modelAnalysis.resources });
  const models = ordered.map((definition) => {
    const anchors = schemaContext(
      document,
      sharedSchemaContext,
      definition.schemaName,
      definition.rawSchema,
    ).anchors;
    const env = modelEnv(document, undefined, anchors, modelAnalysis.resources, modelAnalysis.selections, modelAnalysis.dates);
    const fieldEnv = withSchemaBase(env, definition.rawSchema);
    const fields = [...definition.properties.entries()].map(([name, schema]) => ({
      name,
      required: definition.required.has(name),
      type: render(modelFieldType(schema, byName, fieldEnv)),
      modelReferences: [...new Set([
        modelSchemaReference(schema, fieldEnv),
        ...(isJsonObject(schema) && schema.type === 'array'
          ? [modelSchemaReference(schema.items, fieldEnv)]
          : []),
      ].filter((reference): reference is string => Boolean(reference && byName.has(reference))))].sort(),
    }));
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
      generated: {
        module: `./models/${definition.name}.ts`,
        export: `${definition.name}Model`,
      },
      fields,
      inheritance: definition.baseName && byName.get(definition.baseName)
        ? { baseModelId: stableId(byName.get(definition.baseName) ?? definition) }
        : null,
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
    ...(profile.validation ? {
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
        ...(idsByName.has(node.name) ? [idsByName.get(node.name) ?? ''] : []),
      ].filter(Boolean))],
    }));
}

/** The runtime codec id of a model: what the manifest records and a rewrite stamps. */
function openApiCodecId(analysis: OpenApiModelAnalysis, name: string): string {
  return analysis.nodesByName.get(name)?.codecId ?? codecPublicId(name, { kind: 'unknown' }, undefined, { source: 'openapi', constructs: true });
}
