import { reachesRecursiveNode } from '@exprtlabs/golem/internal/emitter';
import type { SchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import type { CodecSchemaClosureEntry } from '@exprtlabs/golem/internal/validation-plan';
import type { JsonSchema } from '@exprtlabs/golem/internal/schema';
import { sourceDigest } from '@exprtlabs/golem/internal/generator-support';
import { asRecord, isJsonObject, objectEntries } from './json.js';
import { compareText } from '@exprtlabs/golem/generator-api';
import { identifier } from '@exprtlabs/golem/internal/generator-support';
import type { GolemModeManifest, SdkOperationValidation, SdkOperationValue } from '@exprtlabs/golem/manifest';
import type { OperationValidationSchemas } from './client/emit.js';
import type { NormalizedOperation } from './normalize.js';
import { GENERATOR_NAME, PACKAGE_VERSION } from './package-info.js';
import type { OpenApiGenerationProfile } from './profile.js';
import { requireProfile } from './profile.js';
import {
  type ModelDefinition,
  type OpenApiModelAnalysis,
  modelBases,
  modelConversionDescriptor,
  modelEnv,
  modelStableId,
} from './model-resolution.js';
import { resolveLocal } from './normalize.js';

/**
 * The schema graph the models job compiles in golem mode: each model and recursive alias with its codec id, and the operations' values.
 * Descriptors are JSON text (see `SdkDescriptorText`). The data is the graph's inputs, so interning it again with these codec ids
 * gives the same nodes. A value of a `$ref` is the node of that model and holds no descriptor.
 */
function golemModeGraph(document: unknown, analysis: OpenApiModelAnalysis, sdk: GolemModeOperations, validating: boolean): Pick<GolemModeManifest, 'mode' | 'dates' | 'codecIds' | 'descriptors' | 'operations' | 'validationResources' | 'bases' | 'scalars'> {
  const operations: GolemModeManifest['operations'][number][] = [];
  // An operation is listed when it converts a value or the SDK validates; the order is the order of the SDK's operations, then its inbound ones.
  for (const operation of sdk.operations) {
    const values: SdkOperationValue[] = [];
    for (const [key, node] of analysis.convertedNodeIds) {
      const [name, ...at] = JSON.parse(key) as [string, ...string[]];
      if (name !== operation.name) continue;
      const input = analysis.graphInputs.values.get(key);
      const inline = input && { ...(input.name === undefined ? {} : { name: input.name }), descriptor: JSON.stringify(input.descriptor) };
      values.push({ at, node, ...(inline ? { inline } : {}) });
    }
    const bundle = sdk.validation?.bundles.get(operation.name);
    const validation: SdkOperationValidation | undefined = bundle && {
      input: bundle.inputReference,
      ...(bundle.headersReference === undefined ? {} : { headers: bundle.headersReference }),
      responses: bundle.responseReferences.map((item) => ({ key: `${item.status}:${item.contentType}`, root: item.reference })),
      responseHeaders: bundle.responseHeaderReferences.map((item) => ({ key: `${item.status}:${item.name}`, root: item.reference })),
      roots: bundle.roots,
    };
    if (values.length === 0 && validation === undefined) continue;
    operations.push({ name: operation.name, ...(operation.sourceKind === 'path' ? {} : { inbound: true }), values, ...(validation ? { validation } : {}) });
  }
  // A resource that several operations hold is the same schema in each, so one copy serves them all.
  const resources = Object.fromEntries([...(sdk.validation?.bundles.values() ?? [])]
    .flatMap((bundle) => Object.entries(bundle.schemas))
    .sort(([left], [right]) => compareText(left, right)));
  // The models that each model narrows, which the codec emitter reads to merge an intersection.
  const bases = Object.fromEntries(analysis.graphInputs.models.flatMap(({ name }) => {
    const declared = modelBases(analysis.definitions.get(name));
    return declared.length ? [[name, declared] as const] : [];
  }));
  return {
    mode: 'golem',
    dates: analysis.dates,
    codecIds: Object.fromEntries(analysis.graphInputs.models.map(({ name }) => [name, openApiCodecId(analysis, name)])),
    descriptors: analysis.graphInputs.models.map(({ name, descriptor }) => ({ name, descriptor: JSON.stringify(descriptor) })),
    bases,
    scalars: scalarComponents(document, analysis),
    operations,
    ...(validating ? { validationResources: resources } : {}),
  };
}

/** The descriptor kinds of a scalar the SDK writes as a plain type alias: its limits are the descriptor's constraints. */
const SCALAR_KINDS: ReadonlySet<string> = new Set(['string', 'number', 'boolean']);

/**
 * The component schemas that are one string, number or boolean and no model or recursive alias: the SDK writes `export type Name = string`,
 * which keeps none of their limits, so the manifest records their descriptors under the provenance of that type.
 */
function scalarComponents(document: unknown, analysis: OpenApiModelAnalysis): GolemModeManifest['scalars'] {
  const env = modelEnv(document, undefined, undefined, analysis.resources, analysis.selections, analysis.dates);
  return objectEntries(asRecord(asRecord(asRecord(document).components).schemas)).flatMap(([rawName, rawSchema]) => {
    const name = identifier(rawName);
    const schema = resolveLocal(document, rawSchema);
    if (analysis.definitions.has(name) || analysis.definitions.aliases.has(name) || !isJsonObject(schema)) return [];
    if (schema.type !== 'string' && schema.type !== 'number' && schema.type !== 'integer' && schema.type !== 'boolean') return [];
    const descriptor = modelConversionDescriptor(rawSchema, analysis.definitions, env, 'to');
    if (!SCALAR_KINDS.has(descriptor.kind)) return [];
    return [{ name, type: { module: './types.ts', export: name, aliases: [{ module: './index.ts', export: name }] }, descriptor: JSON.stringify(descriptor) }];
  });
}

/** What an SDK of mode golem writes into its manifest besides the schema graph: its operations (outbound, then inbound) and their validation roots. */
export interface GolemModeOperations {
  readonly operations: readonly NormalizedOperation[];
  readonly validation: OperationValidationSchemas | undefined;
}

/** `golem` mode writes the schema graph in place of the data-only validation closure; `standalone` keeps the closure. */
export function generateModelManifest(
  document: unknown,
  profile: OpenApiGenerationProfile,
  modelAnalysis: OpenApiModelAnalysis,
  mode: 'standalone' | 'golem' = 'standalone',
  golem: GolemModeOperations = { operations: [], validation: undefined },
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
    // A golem-mode SDK imports the installed @exprtlabs/golem and records the version it needs; a standalone SDK carries its own runtime and records none.
    ...(mode === 'golem' ? { runtime: { name: '@exprtlabs/golem', minimumVersion: PACKAGE_VERSION } } : {}),
    source: {
      kind: 'openapi',
      dialect: asRecord(document).openapi,
      digest,
    },
    profile,
    models,
    ...(mode === 'golem' ? golemModeGraph(document, modelAnalysis, golem, Boolean(profile.validation)) : {}),
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
