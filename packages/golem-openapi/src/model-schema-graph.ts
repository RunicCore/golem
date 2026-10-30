import { createHash } from 'node:crypto';
import { createSchemaGraph, internDescriptors, type SchemaGraph, type SchemaNode } from '@exprtlabs/golem/internal/schema-graph';
import type { ModelTypeDescriptor } from '@exprtlabs/golem/internal/schema';
import { compareText } from '@exprtlabs/golem/generator-api';
import type { OpenApiGenerationProfile } from './profile.js';
import { parameterSchema, resolveLocal, type NormalizedOperation } from './normalize.js';
import { objectEntries } from './json.js';
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
  type SchemaGraphInput,
  type SchemaGraphInputs,
  modelEnv,
  aliasDescriptor,
  CompositionError,
  locatedCompositionError,
  modelConversionDescriptor,
  type SchemaGraphGrouping,
} from './model-resolution.js';
import { collectOpenApiModelDefinitions } from './model-definitions.js';

/** The node name of an inline body, parameter or header that is no object: the graph keeps unnamed objects only, and equal shapes under this name share one codec. */
const OPERATION_VALUE_NODE_NAME = '__operationValue';

/** The key of a request body in `OpenApiModelAnalysis.convertedNodeIds`: the operation and the request content type. */
export function requestBodyKey(operation: string, contentType: string): string {
  return JSON.stringify([operation, 'request', contentType]);
}

/** The key of a response body, or of its stream items, in `OpenApiModelAnalysis.convertedNodeIds`: the operation and the response status and content type. */
export function responseBodyKey(operation: string, status: string, contentType: string): string {
  return JSON.stringify([operation, 'response', status, contentType]);
}

/** The key of a request parameter in `OpenApiModelAnalysis.convertedNodeIds`: the operation, where the parameter is (`path`, `query`, `header`, `cookie` or `querystring`) and its name. */
export function parameterKey(operation: string, location: string, name: string): string {
  return JSON.stringify([operation, 'parameter', location, name]);
}

/** The key of a response header in `OpenApiModelAnalysis.convertedNodeIds`: the operation, the response status and the header name. */
export function responseHeaderKey(operation: string, status: string, name: string): string {
  return JSON.stringify([operation, 'response-header', status, name]);
}

/** Whether a value of `descriptor` changes between its wire and its plain form: a Date or Temporal value anywhere inside, through the components it references. */
function descriptorConverts(descriptor: ModelTypeDescriptor, graph: SchemaGraph, seen: Set<string>): boolean {
  const tags = descriptor as ModelTypeDescriptor & { readonly serde?: unknown };
  if (tags.serde !== undefined || descriptor.kind === 'date') return true;
  const converts = (held: ModelTypeDescriptor): boolean => descriptorConverts(held, graph, seen);
  switch (descriptor.kind) {
    case 'generated-model':
    case 'reference': {
      const node = graph.nodeFor(descriptor);
      if (!node || seen.has(node.id)) return false;
      seen.add(node.id);
      return converts(node.descriptor);
    }
    case 'array': return converts(descriptor.item);
    case 'tuple': return descriptor.items.some(converts) || (descriptor.rest !== undefined && converts(descriptor.rest.item));
    case 'object': return Object.values(descriptor.properties).some(converts) || (typeof descriptor.additionalProperties === 'object' && converts(descriptor.additionalProperties));
    case 'union':
    case 'intersection': return descriptor.variants.some(converts);
    default: return false;
  }
}

/**
 * Interns the request body, response body, stream item, parameter and response header schema of each operation that converts something, and returns the node of each by its key.
 * A `$ref` to a component uses the component's node and an inline shape the anonymous node of its shape, so equal shapes share one codec.
 * A schema that converts nothing gets no node: the client passes its value through.
 */
function internOperationValues(
  document: unknown,
  schemaGraph: SchemaGraph,
  operations: readonly NormalizedOperation[],
  definitions: ModelDefinitions,
  env: ModelResolveEnv,
  validation: OpenApiGenerationProfile['validation'],
): { readonly convertedNodeIds: ReadonlyMap<string, string>; readonly values: ReadonlyMap<string, SchemaGraphInput> } {
  const convertedNodeIds = new Map<string, string>();
  const values = new Map<string, SchemaGraphInput>();
  const intern = (key: string, schema: unknown): void => {
    if (schema === null || typeof schema === 'boolean') return;
    let descriptor: ModelTypeDescriptor;
    try {
      descriptor = modelConversionDescriptor(schema, definitions, env, 'to');
    } catch (thrown) {
      // A schema that does not convert gets no node. `checkOperationCompositions` runs next, stops generation, and names the schema and the place in it.
      if (thrown instanceof CompositionError) return;
      throw thrown;
    }
    if (!descriptorConverts(descriptor, schemaGraph, new Set())) return;
    const named = descriptor.kind === 'generated-model' || descriptor.kind === 'reference';
    const valueName = descriptor.kind === 'object' ? undefined : OPERATION_VALUE_NODE_NAME;
    const node = named ? schemaGraph.nodeFor(descriptor) : schemaGraph.intern(descriptor, valueName, false, validation);
    if (!node) return;
    convertedNodeIds.set(key, node.id);
    if (!named) values.set(key, { ...(valueName === undefined ? {} : { name: valueName }), descriptor });
  };
  for (const operation of operations) {
    for (const parameter of operation.parameters) intern(parameterKey(operation.name, parameter.in, parameter.name), parameterSchema(parameter));
    for (const media of operation.requestContent) intern(requestBodyKey(operation.name, media.contentType), media.schema);
    for (const response of operation.responses) {
      for (const [name, header] of objectEntries(response.headers)) intern(responseHeaderKey(operation.name, response.status, name), parameterSchema(resolveLocal(document, header)));
      for (const media of response.content) {
        intern(responseBodyKey(operation.name, response.status, media.contentType), media.itemSchemaPresent ? media.itemSchema : media.schema);
      }
    }
  }
  return { convertedNodeIds, values };
}

/**
 * A model owns its codec. `allOf: [{ $ref: X }]` collapses to a bare
 * reference to X, which would make the model delegate to a codec that is
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
  validation: OpenApiGenerationProfile['validation'] = true,
  resources?: ResourceIndex,
  selections?: DiscriminatorSelections,
  dates: OpenApiDates = 'date',
  operations: readonly NormalizedOperation[] = [],
): { readonly schemaGraph: SchemaGraph; readonly nodeIdByDefinition: ReadonlyMap<string, string>; readonly convertedNodeIds: ReadonlyMap<string, string>; readonly graphInputs: SchemaGraphInputs } {
  const schemaGraph = createSchemaGraph({}, {
    codecSource: 'openapi',
  });
  const sharedSchemaContext = schemaContext(document, resources ? { resources } : {});
  const aliasEnv = modelEnv(document, undefined, undefined, resources, selections, dates);
  const aliasEntries = [...definitions.aliases.values()].map((alias) => ({
    name: alias.name,
    descriptor: locatingComposition(alias.schemaName, () => aliasDescriptor(alias, definitions, aliasEnv)),
    emitClass: false,
    validation,
  }));
  const modelEntries = [...ordered.map((definition) => {
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
      emitClass: false,
      validation,
    };
  }), ...aliasEntries];
  const nodeIdByDefinition = internDescriptors(schemaGraph, modelEntries);
  const { convertedNodeIds, values } = internOperationValues(document, schemaGraph, operations, definitions, aliasEnv, validation);
  schemaGraph.seal();
  return { schemaGraph, nodeIdByDefinition, convertedNodeIds, graphInputs: { models: modelEntries.map(({ name, descriptor }) => ({ name, descriptor })), values } };
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
  validation: OpenApiGenerationProfile['validation'] = true,
  dates: OpenApiDates = 'date',
  operations: readonly NormalizedOperation[] = [],
): OpenApiModelAnalysis {
  const resources = collectCanonicalResources(document);
  const { definitions, ordered, diagnostics, selections } = collectOpenApiModelDefinitions(document, resources, dates);
  const { schemaGraph, nodeIdByDefinition, convertedNodeIds, graphInputs } = internOpenApiSchemaGraph(document, ordered, definitions, validation, resources, selections, dates, operations);
  for (const alias of definitions.aliases.values()) {
    const nodeId = nodeIdByDefinition.get(alias.name);
    if (nodeId !== undefined) alias.nodeId = nodeId;
  }
  const nodes = [...schemaGraph.nodes.values()];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const { nodesByName, definitionNameByNodeId } = nodesByDefinitionName(schemaGraph, new Map([...nodeIdByDefinition].filter(([name]) => definitions.has(name))));
  const nodesByCodecId = new Map(nodes.map((node) => [node.codecId, node]));
  const grouping = schemaGraphGroups(schemaGraph, definitions, nodesByName);
  return { definitions, ordered, schemaGraph, grouping, resources, nodesById, nodesByName, definitionNameByNodeId, nodesByCodecId, convertedNodeIds, graphInputs, diagnostics, selections, dates };
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
    // Inheritance and discriminator dispatch produce codec references that
    // are not necessarily represented by codec-schema edges. Keep every such
    // cycle inside one ESM module so a codec cannot observe a partially
    // initialized binding.
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
    const id = `group-${hashGroup([...ids].map((nodeId) => schemaGraph.nodes.get(nodeId)?.codecId ?? nodeId))}`;
    const other = described.get(id);
    if (other) throw new Error(`Internal error: the schema groups [${other.join(', ')}] and [${ids.join(', ')}] have the same id ${id}; one would overwrite the other's file models/_${id}.ts`);
    described.set(id, ids);
    for (const nodeId of ids) owner.set(nodeId, id);
    return { id, filename: `models/_${id}.ts`, nodes: new Set(ids) };
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
