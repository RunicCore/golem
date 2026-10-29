import { createHash } from 'node:crypto';
import { createSchemaGraph, internDescriptors, type SchemaGraph, type SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { compareText } from '@exprtlabs/golem/generator-api';
import { componentOrigin, LocatedError } from './origin.js';
import { schemaContext } from './types.js';
import { collectCanonicalResources, type ResourceIndex } from './schema-projection.js';
import {
  type ModelDefinition,
  ModelDefinitions,
  type DiscriminatorSelections,
  type OpenApiDates,
  type ModelResolveEnv,
  type OpenApiModelAnalysis,
  modelEnv,
  aliasDescriptor,
  CompositionError,
  locatedCompositionError,
  modelConversionDescriptor,
  type SchemaGraphGrouping,
} from './model-resolution.js';
import { collectOpenApiModelDefinitions } from './model-definitions.js';

/**
 * A model class owns its codec. `allOf: [{ $ref: X }]` collapses to a bare
 * reference to X, which would make the subclass delegate to a codec that is
 * never registered under its own id; keep it an object node extending X, as
 * `allOf: [{ $ref: X }, { type: 'object' }]` would.
 */
function modelClassDescriptor(
  descriptor: ModelTypeDescriptor,
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
): ModelTypeDescriptor {
  if (descriptor.kind !== 'generated-model') return descriptor;
  // The alias has exactly its base's shape, including its policy for undeclared members.
  const base = definitions.get(descriptor.id);
  const baseDescriptor = base ? modelConversionDescriptor(base.rawSchema, definitions, env, 'to', new Set(), true, 'definition') : undefined;
  // The alias keeps its own constraints (`unevaluatedProperties: false` of `allOf [$ref Base]`).
  if (baseDescriptor?.kind === 'object') {
    return descriptor.constraints
      ? { ...baseDescriptor, constraints: [...(baseDescriptor.constraints ?? []), ...descriptor.constraints] }
      : { ...baseDescriptor };
  }
  return {
    kind: 'intersection',
    variants: [descriptor, { kind: 'object', properties: {}, required: [], additionalProperties: true }],
  };
}

/** A schema that stops generation names the component it sits in. */
function locatingComposition<Result>(owner: string, resolve: () => Result): Result {
  try {
    return resolve();
  } catch (thrown) {
    throw thrown instanceof CompositionError ? locatedCompositionError(owner, thrown) : thrown;
  }
}

function internOpenApiSchemaGraph(
  document: unknown,
  ordered: readonly ModelDefinition[],
  definitions: ModelDefinitions,
  validationEnabled = true,
  resources?: ResourceIndex,
  selections?: DiscriminatorSelections,
  dates: OpenApiDates = 'date',
): { readonly schemaGraph: SchemaGraph; readonly nodeIdByDefinition: ReadonlyMap<string, string> } {
  const schemaGraph = createSchemaGraph({}, {
    codecSource: 'openapi',
  });
  const sharedSchemaContext = schemaContext(document, resources ? { resources } : {});
  const aliasEnv = modelEnv(document, undefined, undefined, resources, selections, dates);
  const aliasEntries = [...definitions.aliases.values()].map((alias) => ({
    name: alias.name,
    descriptor: locatingComposition(alias.schemaName, () => aliasDescriptor(alias, definitions, aliasEnv)),
    emitClass: false,
    validationEnabled,
  }));
  const nodeIdByDefinition = internDescriptors(schemaGraph, [...ordered.map((definition) => {
    const anchors = schemaContext(
      document,
      sharedSchemaContext,
      definition.schemaName,
      definition.rawSchema,
    ).anchors;
    const env = modelEnv(document, undefined, anchors, resources, selections, dates);
    return {
      name: definition.name,
      descriptor: locatingComposition(definition.schemaName, () => definition.isUnion
        ? modelConversionDescriptor(definition.rawSchema, definitions, env, 'to')
        : modelClassDescriptor(modelConversionDescriptor(definition.rawSchema, definitions, env, 'to', new Set(), true, 'definition'), definitions, env)),
      emitClass: true,
      validationEnabled,
    };
  }), ...aliasEntries]);
  schemaGraph.seal();
  return { schemaGraph, nodeIdByDefinition };
}

/**
 * Each schema resolves to the node interned for it. Graph nodes carry the short codec name, so
 * schemas that shorten alike (`PaymentModel`, `TPayment`, `Payment`) have separate nodes only
 * when their shapes differ; equal shapes would share one codec and are rejected.
 */
function nodesByDefinitionName(
  schemaGraph: SchemaGraph,
  nodeIdByDefinition: ReadonlyMap<string, string>,
): { readonly nodesByName: Map<string, SchemaNode>; readonly definitionNameByNodeId: Map<string, string> } {
  const nodes = [...schemaGraph.nodes.values()];
  const shortCounts = new Map<string, number>();
  for (const node of nodes) shortCounts.set(node.name, (shortCounts.get(node.name) ?? 0) + 1);
  const nodesByName = new Map(nodes.filter((node) => shortCounts.get(node.name) === 1).map((node) => [node.name, node] as const));
  const definitionNameByNodeId = new Map<string, string>();
  for (const [definitionName, nodeId] of nodeIdByDefinition) {
    const node = schemaGraph.nodes.get(nodeId);
    if (!node) throw new Error(`Internal error: model ${definitionName} has no schema node.`);
    const other = definitionNameByNodeId.get(node.id);
    if (other !== undefined) {
      const otherNamed = JSON.stringify(other);
      const named = JSON.stringify(definitionName);
      throw new LocatedError(`OpenAPI components ${otherNamed} and ${named} both map to the model name "${node.name}" once characters that are not letters, digits or underscores are replaced. Rename one of them.`, [componentOrigin('schemas', other, otherNamed), componentOrigin('schemas', definitionName, named)]);
    }
    definitionNameByNodeId.set(node.id, definitionName);
    nodesByName.set(definitionName, node);
  }
  return { nodesByName, definitionNameByNodeId };
}

export function analyzeOpenApiModels(
  document: unknown,
  validationEnabled = true,
  dates: OpenApiDates = 'date',
): OpenApiModelAnalysis {
  const resources = collectCanonicalResources(document);
  const { definitions, ordered, diagnostics, selections } = collectOpenApiModelDefinitions(document, resources, dates);
  const { schemaGraph, nodeIdByDefinition } = internOpenApiSchemaGraph(document, ordered, definitions, validationEnabled, resources, selections, dates);
  for (const alias of definitions.aliases.values()) {
    const nodeId = nodeIdByDefinition.get(alias.name);
    if (nodeId !== undefined) alias.nodeId = nodeId;
  }
  const nodes = [...schemaGraph.nodes.values()];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const { nodesByName, definitionNameByNodeId } = nodesByDefinitionName(schemaGraph, new Map([...nodeIdByDefinition].filter(([name]) => definitions.has(name))));
  const nodesByCodecId = new Map(nodes.map((node) => [node.codecId, node]));
  const grouping = schemaGraphGroups(schemaGraph, definitions, nodesByName, definitionNameByNodeId);
  return { definitions, ordered, schemaGraph, grouping, resources, nodesById, nodesByName, definitionNameByNodeId, nodesByCodecId, diagnostics, selections, dates };
}

export function schemaGraphView(
  graph: SchemaGraph,
  nodeIds: ReadonlySet<string>,
  dependencyIds: ReadonlySet<string> = new Set(),
): SchemaGraph {
  const nodes = new Map<string, SchemaNode>();
  for (const [id, node] of graph.nodes) {
    if (nodeIds.has(id)) nodes.set(id, node);
    else if (dependencyIds.has(id)) {
      nodes.set(id, {
        ...node,
        descriptor: { kind: 'generated-model', id: node.name },
        edges: [],
        kind: 'reference',
      });
    }
  }
  return {
    nodes,
    intern: graph.intern.bind(graph),
    nodeFor: graph.nodeFor.bind(graph),
    seal: () => undefined,
    topo: () => graph.topo().flatMap((node) => {
      const emitted = nodes.get(node.id);
      return emitted ? [emitted] : [];
    }),
  };
}

function schemaGraphGroups(
  schemaGraph: SchemaGraph,
  definitions: ModelDefinitions,
  nodesByName: ReadonlyMap<string, SchemaNode>,
  definitionNameByNodeId: ReadonlyMap<string, string>,
): SchemaGraphGrouping {
  const runtimeEdges = new Map([...schemaGraph.nodes].map(([id, node]) => [id, new Set(node.edges)]));
  const addRuntimeEdge = (fromName: string, toName: string | undefined): void => {
    if (!toName) return;
    const from = nodesByName.get(fromName);
    const to = nodesByName.get(toName);
    if (!from || !to) return;
    runtimeEdges.get(from.id)?.add(to.id);
  };
  for (const definition of definitions.values()) {
    // Inheritance and discriminator dispatch produce runtime class references
    // that are not necessarily represented by codec-schema edges. Keep every
    // class-load cycle inside one ESM module so subclass/union initialization
    // cannot observe a partially initialized binding.
    addRuntimeEdge(definition.name, definition.baseName ?? undefined);
    for (const variant of definition.variants ?? []) addRuntimeEdge(definition.name, variant);
  }
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (id: string): void => {
    const index = nextIndex++;
    indices.set(id, index);
    lowLinks.set(id, index);
    stack.push(id);
    onStack.add(id);
    for (const target of [...(runtimeEdges.get(id) ?? [])].sort()) {
      if (!schemaGraph.nodes.has(target)) continue;
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? index, lowLinks.get(target) ?? index));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? index, indices.get(target) ?? index));
      }
    }
    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component.sort());
  };
  for (const id of [...schemaGraph.nodes.keys()].sort()) if (!indices.has(id)) visit(id);

  const owner = new Map<string, string>();
  const described = new Map<string, readonly string[]>();
  const groups = components.map((ids) => {
    const models = new Set(ids.flatMap((id) => {
      const model = definitionNameByNodeId.get(id);
      return model === undefined ? [] : [model];
    }));
    const id = `group-${hashGroup([...ids].map((nodeId) => schemaGraph.nodes.get(nodeId)?.codecId ?? nodeId))}`;
    const other = described.get(id);
    if (other) throw new Error(`Internal error: the schema groups [${other.join(', ')}] and [${ids.join(', ')}] have the same id ${id}; one would overwrite the other's file models/_${id}.ts`);
    described.set(id, ids);
    for (const nodeId of ids) owner.set(nodeId, id);
    return { id, filename: `models/_${id}.ts`, nodes: new Set(ids), models };
  }).sort((left, right) => compareText(left.id, right.id));
  return { groups, owner, runtimeEdges };
}

/** A sha256 prefix of the group's sorted codec ids, so that two groups do not share an id by chance. */
function hashGroup(ids: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex').slice(0, 16);
}

export function reachableSchemaNodes(
  schemaGraph: SchemaGraph,
  roots: ReadonlySet<string>,
  runtimeEdges?: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const result = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || result.has(id)) continue;
    result.add(id);
    for (const edge of runtimeEdges?.get(id) ?? schemaGraph.nodes.get(id)?.edges ?? []) pending.push(edge);
  }
  return result;
}
