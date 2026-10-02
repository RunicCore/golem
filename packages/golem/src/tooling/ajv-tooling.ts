import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import * as FormatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import * as StandaloneModule from 'ajv/dist/standalone/index.js';
import { buildSync } from 'esbuild';
import { addModelKeywords, addValidationKeyword } from '../ajv-keywords.js';
import { lowerDiscriminatorMappings } from '../discriminator-mapping.js';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX } from '../schema-keywords.js';
import { codecShortName, type SchemaGraph, type SchemaNode } from './schema-graph.js';
import type { JsonSchema } from './schema.js';

export interface StandaloneValidatorInput {
  readonly schemas: Readonly<Record<string, object | boolean>>;
  readonly references: readonly string[];
  readonly owner: string;
}

export interface StandaloneValidatorOutput {
  readonly code: string;
  readonly declarations: string;
  readonly notices: string;
}

/** Schema data copied from a generated-model manifest for standalone closure. */
export interface CodecSchemaClosureEntry {
  readonly codecId: string;
  readonly modelSchema: JsonSchema;
  readonly wireSchema?: JsonSchema;
  /** What parse checks after decoding (`codecId#model-only`). */
  readonly modelOnlySchema?: JsonSchema;
  /** What stringify checks after encoding (`codecId#wire-only`). */
  readonly wireOnlySchema?: JsonSchema;
  readonly aliases?: readonly string[];
}

export interface CodecValidationPlan {
  readonly schemas: Readonly<Record<string, object | boolean>>;
  readonly references: readonly string[];
}

interface GraphDefinitionTarget {
  readonly reference: string;
  readonly schema: JsonSchema;
}

function withoutRootDefinitions(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(schema)) {
    if (key !== '$defs') copy[key] = value;
  }
  return copy;
}

function ownedGraphDefinitions(
  value: unknown,
  preferredDefinitions: ReadonlyMap<string, GraphDefinitionTarget> | undefined,
): Map<string, GraphDefinitionTarget> {
  const owned = new Map<string, GraphDefinitionTarget>();
  if (!preferredDefinitions || value === null || typeof value !== 'object' || Array.isArray(value)) return owned;
  const definitions = Reflect.get(value, '$defs');
  if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) return owned;
  for (const [name, definition] of Object.entries(definitions)) {
    const target = preferredDefinitions.get(name);
    if (target
      && stableSchema(withoutRootDefinitions(target.schema))
        === stableSchema(withoutRootDefinitions(definition))) {
      owned.set(name, target);
    }
  }
  return owned;
}

/** Canonical identity view for comparison only; executable input is unchanged. */
function schemaIdentityView(
  value: object | boolean,
  preferredDefinitions: ReadonlyMap<string, GraphDefinitionTarget> | undefined,
): object | boolean {
  const owned = ownedGraphDefinitions(value, preferredDefinitions);
  if (owned.size === 0 || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const definitions = Reflect.get(value, '$defs');
  if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) return value;
  const normalizedDefinitions = Object.create(null) as Record<string, unknown>;
  for (const [name, definition] of Object.entries(definitions)) {
    const target = owned.get(name);
    normalizedDefinitions[name] = target ? { $ref: target.reference } : definition;
  }
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = key === '$defs' ? normalizedDefinitions : child;
  }
  return normalized;
}

function localDefinitionName(reference: string): string | undefined {
  const prefix = '#/$defs/';
  if (!reference.startsWith(prefix)) return undefined;
  const segment = reference.slice(prefix.length);
  if (segment.length === 0 || segment.includes('/')) return undefined;
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function isFormats(value: unknown): value is FormatsPlugin {
  return typeof value === 'function' && 'get' in value;
}

function isStandalone(value: unknown): value is (ajv: Ajv2020, refs: Record<string, string>) => string {
  return typeof value === 'function';
}

function stableSchema(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSchema).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSchema(Reflect.get(value, key))}`).join(',')}}`;
}

function schemaWithId(schema: JsonSchema, id: string): object | boolean {
  if (typeof schema === 'boolean') return schema ? { $id: id } : { $id: id, not: true };
  if (schema.$id !== undefined && schema.$id !== id) {
    throw new TypeError(
      `Standalone schema identity ${JSON.stringify(schema.$id)} conflicts with codec identity ${JSON.stringify(id)}.`,
    );
  }
  return { ...schema, $id: id };
}

function schemaNodeAliases(node: SchemaNode): readonly string[] {
  return [...new Set([node.codecId, node.id, node.name, codecShortName(node.name)])];
}

/**
 * Build the complete data-only Ajv schema set for generated object codecs.
 * Generated-model placeholder refs are resolved while generation still has
 * graph and manifest identity; the emitted runtime never discovers schemas.
 */
export function buildCodecValidationPlan(
  graphOrGraphs: SchemaGraph | readonly SchemaGraph[],
  externalCodecs: readonly CodecSchemaClosureEntry[] = [],
  additionalSchemas: Readonly<Record<string, JsonSchema>> = {},
): CodecValidationPlan {
  const graphs = Array.isArray(graphOrGraphs) ? graphOrGraphs : [graphOrGraphs];
  const nodes = graphs.flatMap(graph => [...graph.nodes.values()]
    .map(node => ({ graph, node })))
    .sort((left, right) => left.node.codecId.localeCompare(right.node.codecId) || left.node.id.localeCompare(right.node.id));
  const aliases = new Map<string, Set<string>>();
  const addAlias = (target: Map<string, Set<string>>, alias: string, codecId: string): void => {
    let codecIds = target.get(alias);
    if (!codecIds) {
      codecIds = new Set();
      target.set(alias, codecIds);
    }
    codecIds.add(codecId);
  };
  const addGlobalAlias = (alias: string, codecId: string): void => addAlias(aliases, alias, codecId);
  const localAliases = new Map<SchemaGraph, Map<string, Set<string>>>();
  const localModelDefinitions = new Map<SchemaGraph, Map<string, GraphDefinitionTarget>>();
  const localWireDefinitions = new Map<SchemaGraph, Map<string, GraphDefinitionTarget>>();
  for (const graph of graphs) {
    const graphAliases = new Map<string, Set<string>>();
    localAliases.set(graph, graphAliases);
    const modelDefinitions = new Map<string, GraphDefinitionTarget>();
    const wireDefinitions = new Map<string, GraphDefinitionTarget>();
    localModelDefinitions.set(graph, modelDefinitions);
    localWireDefinitions.set(graph, wireDefinitions);
    for (const node of graph.nodes.values()) {
      if (node.kind === 'reference') continue;
      for (const alias of schemaNodeAliases(node)) addAlias(graphAliases, alias, node.codecId);
      if (node.validationEnabled !== false) {
        modelDefinitions.set(node.codecId, {
          reference: node.codecId,
          schema: node.modelJsonSchema ?? node.jsonSchema,
        });
        wireDefinitions.set(node.codecId, {
          reference: node.sameSchema ? node.codecId : `${node.codecId}#wire`,
          schema: node.jsonSchema,
        });
      }
    }
    for (const node of graph.nodes.values()) {
      if (node.descriptor.kind !== 'generated-model') continue;
      const externalId = node.descriptor.id;
      const exact = externalCodecs.filter(codec => codec.codecId === externalId || codec.aliases?.includes(externalId));
      const externalAlias = externalId.includes('/') ? externalId.slice(externalId.lastIndexOf('/') + 1) : externalId;
      const placeholder = externalAlias.replace(/[^A-Za-z0-9_]/g, '_');
      for (const codec of exact) {
        addAlias(graphAliases, placeholder, codec.codecId);
      }
    }
  }
  for (const { node } of nodes) {
    if (node.kind === 'reference') continue;
    for (const alias of schemaNodeAliases(node)) addGlobalAlias(alias, node.codecId);
  }
  for (const codec of externalCodecs) {
    addGlobalAlias(codec.codecId, codec.codecId);
    for (const alias of codec.aliases ?? []) addGlobalAlias(alias, codec.codecId);
  }

  const schemas: Record<string, object | boolean> = Object.create(null) as Record<string, object | boolean>;
  const schemaAliases = new Map<string, Map<string, Set<string>>>();
  const schemaDefinitions = new Map<string, Map<string, GraphDefinitionTarget>>();
  const addSchema = (
    id: string,
    schema: JsonSchema,
    preferredAliases?: Map<string, Set<string>>,
    preferredDefinitions?: Map<string, GraphDefinitionTarget>,
  ): void => {
    const withId = schemaWithId(schema, id);
    const previous = schemas[id];
    if (previous !== undefined) {
      if (stableSchema(schemaIdentityView(previous, schemaDefinitions.get(id)))
        !== stableSchema(schemaIdentityView(withId, preferredDefinitions))) {
        throw new TypeError(`Conflicting standalone schema identity ${JSON.stringify(id)}.`);
      }
      // Keep the first schema paired with the definition context recorded for
      // it above. Replacing only the payload would leave that context attached
      // to a different schema representation on later candidates.
      return;
    }
    schemas[id] = withId;
    if (preferredAliases && !schemaAliases.has(id)) schemaAliases.set(id, preferredAliases);
    if (preferredDefinitions && !schemaDefinitions.has(id)) schemaDefinitions.set(id, preferredDefinitions);
  };
  for (const { graph, node } of nodes) {
    if (node.kind === 'reference' || node.validationEnabled === false) continue;
    const graphAliases = localAliases.get(graph);
    addSchema(
      node.codecId,
      node.modelJsonSchema ?? node.jsonSchema,
      graphAliases,
      localModelDefinitions.get(graph),
    );
    if (!node.sameSchema) {
      addSchema(
        `${node.codecId}#wire`,
        node.jsonSchema,
        graphAliases,
        localWireDefinitions.get(graph),
      );
    }
    // Residual schemas reference other models only by generated-model id; no local $defs.
    if (node.modelOnlyJsonSchema !== undefined) addSchema(`${node.codecId}#model-only`, node.modelOnlyJsonSchema, graphAliases);
    if (node.wireOnlyJsonSchema !== undefined) addSchema(`${node.codecId}#wire-only`, node.wireOnlyJsonSchema, graphAliases);
  }
  for (const codec of externalCodecs) {
    addSchema(codec.codecId, codec.modelSchema);
    if (codec.wireSchema !== undefined
      && stableSchema(codec.modelSchema) !== stableSchema(codec.wireSchema)) {
      addSchema(`${codec.codecId}#wire`, codec.wireSchema);
    }
    if (codec.modelOnlySchema !== undefined) addSchema(`${codec.codecId}#model-only`, codec.modelOnlySchema);
    if (codec.wireOnlySchema !== undefined) addSchema(`${codec.codecId}#wire-only`, codec.wireOnlySchema);
  }
  for (const [id, schema] of Object.entries(additionalSchemas).sort(([left], [right]) => left.localeCompare(right))) {
    addSchema(id, schema);
  }

  const resolveGeneratedModelRefs = (
    value: unknown,
    preferredAliases: Map<string, Set<string>> | undefined,
    preferredDefinitions: Map<string, GraphDefinitionTarget> | undefined,
    wire: boolean,
  ): unknown => {
    const ownedDefinitions = ownedGraphDefinitions(value, preferredDefinitions);

    const active = new WeakSet<object>();
    const visit = (current: unknown, root = false, localReferences = true): unknown => {
      if (Array.isArray(current)) return current.map(item => visit(item, false, localReferences));
      if (current === null || typeof current !== 'object') return current;
      if (active.has(current)) throw new TypeError('Cyclic schema data cannot be compiled as standalone validators.');
      active.add(current);
      try {
        const nestedResource = !root && Object.hasOwn(current, '$id');
        const resolveLocalReferences = localReferences && !nestedResource;
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, item] of Object.entries(current)) {
          if (key === '$ref' && typeof item === 'string' && item.startsWith(GENERATED_MODEL_SCHEMA_REF_PREFIX)) {
            const reference = item.slice(GENERATED_MODEL_SCHEMA_REF_PREFIX.length);
            const hash = reference.indexOf('#');
            // A residual reference names its own plane (`Name#model-only`).
            const name = hash < 0 ? reference : reference.slice(0, hash);
            const residualPlane = hash < 0 ? undefined : reference.slice(hash);
            const candidates = preferredAliases?.get(name)
              ?? preferredAliases?.get(codecShortName(name))
              ?? aliases.get(name)
              ?? aliases.get(codecShortName(name));
            if (candidates && candidates.size > 1) {
              throw new TypeError(
                `Cannot compile standalone validators: generated model schema reference ${JSON.stringify(name)} `
                + `is ambiguous between codec identities ${[...candidates].sort().map(id => JSON.stringify(id)).join(', ')}. `
                + 'Regenerate the referenced model manifest with an unambiguous codec identity.',
              );
            }
            const codecId = candidates?.values().next().value;
            if (codecId === undefined || !Object.hasOwn(schemas, codecId)) {
              throw new TypeError(
                `Cannot compile standalone validators: generated model schema reference ${JSON.stringify(name)} is unresolved. `
                + 'Regenerate the referenced model manifest with standalone schema closure metadata.',
              );
            }
            if (residualPlane !== undefined) {
              if (!Object.hasOwn(schemas, `${codecId}${residualPlane}`)) {
                throw new TypeError(
                  `Cannot compile standalone validators: residual schema ${JSON.stringify(`${codecId}${residualPlane}`)} is unresolved. `
                  + 'Regenerate the referenced model manifest so it publishes residual schemas.',
                );
              }
              result[key] = `${codecId}${residualPlane}`;
              continue;
            }
            // A wire schema refers to the model's wire schema when it has one.
            result[key] = wire && Object.hasOwn(schemas, `${codecId}#wire`) ? `${codecId}#wire` : codecId;
            continue;
          }
          if (key === '$ref' && resolveLocalReferences && typeof item === 'string') {
            const name = localDefinitionName(item);
            const target = name === undefined ? undefined : ownedDefinitions.get(name);
            if (target) {
              result[key] = target.reference;
              continue;
            }
          }
          if (key === '$defs' && item !== null && typeof item === 'object' && !Array.isArray(item)) {
            const definitions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            for (const [name, definition] of Object.entries(item)) {
              if (root && ownedDefinitions.has(name)) continue;
              definitions[name] = visit(definition, false, resolveLocalReferences);
            }
            result[key] = definitions;
            continue;
          }
          result[key] = visit(item, false, resolveLocalReferences);
        }
        return result;
      } finally {
        active.delete(current);
      }
    };
    return visit(value, true);
  };
  for (const id of Object.keys(schemas)) {
    schemas[id] = resolveGeneratedModelRefs(
      schemas[id],
      schemaAliases.get(id),
      schemaDefinitions.get(id),
      id.endsWith('#wire') || id.endsWith('#wire-only'),
    ) as object | boolean;
  }
  return { schemas, references: Object.keys(schemas).sort() };
}

type SchemaRecord = Record<string, unknown>;

function isSchemaRecord(value: unknown): value is SchemaRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keywords whose value is data, not a schema. */
const LITERAL_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);
/** Keywords whose value maps names to schemas, so its keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']);
/** Keywords that never change what validates, so a `$ref` node's own value may replace its target's. */
const ANNOTATION_KEYWORDS = new Set(['$comment', 'title', 'description', 'default', 'examples', 'example', 'deprecated', 'readOnly', 'writeOnly']);
/** Keywords that bind a name or a base to the resource they sit in. */
const RESOURCE_SCOPED_KEYWORDS = ['$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveAnchor', '$recursiveRef'];

/** Copy of a schema node with each schema-valued child replaced by `visit(child, keyword)`. */
function mapSchemaChildren(node: SchemaRecord, visit: (child: unknown, keyword: string) => unknown): SchemaRecord {
  const result: SchemaRecord = Object.create(null) as SchemaRecord;
  for (const [keyword, value] of Object.entries(node)) {
    if (LITERAL_KEYWORDS.has(keyword)) {
      result[keyword] = value;
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && isSchemaRecord(value)) {
      const members: SchemaRecord = Object.create(null) as SchemaRecord;
      for (const [name, member] of Object.entries(value)) members[name] = visit(member, keyword);
      result[keyword] = members;
    } else {
      result[keyword] = Array.isArray(value) ? value.map(child => visit(child, keyword)) : visit(value, keyword);
    }
  }
  return result;
}

interface SchemaReferences {
  readonly references: ReadonlySet<string>;
  /** True when a name or base inside the schema would change meaning in another resource. */
  readonly resourceScoped: boolean;
}

function schemaReferences(schema: SchemaRecord): SchemaReferences {
  const references = new Set<string>();
  let resourceScoped = false;
  const walk = (value: unknown, root: boolean): unknown => {
    if (!isSchemaRecord(value)) return value;
    if (typeof value.$ref === 'string') {
      references.add(value.$ref);
      if (value.$ref.startsWith('#')) resourceScoped = true;
    }
    if ((!root && Object.hasOwn(value, '$id')) || RESOURCE_SCOPED_KEYWORDS.some(keyword => Object.hasOwn(value, keyword))) {
      resourceScoped = true;
    }
    // A definitions map binds names; an empty one binds none.
    for (const keyword of ['$defs', 'definitions']) {
      const definitions = value[keyword];
      if (Object.hasOwn(value, keyword) && !(isSchemaRecord(definitions) && Object.keys(definitions).length === 0)) resourceScoped = true;
    }
    return mapSchemaChildren(value, child => walk(child, false));
  };
  walk(schema, true);
  return { references, resourceScoped };
}

/** Ids that reach themselves through `$ref`, found as strongly connected components (Tarjan). */
function referenceCycleMembers(edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const members = new Set<string>();
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const connect = (id: string): void => {
    index.set(id, index.size);
    lowLink.set(id, index.get(id) as number);
    stack.push(id);
    onStack.add(id);
    for (const next of edges.get(id) ?? []) {
      if (!index.has(next)) {
        connect(next);
        lowLink.set(id, Math.min(lowLink.get(id) as number, lowLink.get(next) as number));
      } else if (onStack.has(next)) {
        lowLink.set(id, Math.min(lowLink.get(id) as number, index.get(next) as number));
      }
    }
    if (lowLink.get(id) !== index.get(id)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length > 1 || edges.get(id)?.has(id)) for (const item of component) members.add(item);
  };
  for (const id of edges.keys()) if (!index.has(id)) connect(id);
  return members;
}

/**
 * Generated models from another file arrive as `#/$defs/<name>` whose definition
 * is only a `$ref` to the model's schema id. Point those refs at the id, and drop
 * a definition once nothing else addresses it, so the schema holds no local name.
 */
function resolveDefinitionAliases(schema: object | boolean, ids: ReadonlySet<string>): object | boolean {
  if (!isSchemaRecord(schema) || !isSchemaRecord(schema.$defs)) return schema;
  const aliases = new Map<string, string>();
  for (const [name, definition] of Object.entries(schema.$defs)) {
    if (isSchemaRecord(definition) && typeof definition.$ref === 'string' && ids.has(definition.$ref)
      && Object.keys(definition).length === 1) aliases.set(name, definition.$ref);
  }
  if (aliases.size === 0) return schema;
  const rewrite = (value: unknown, root: boolean): unknown => {
    // A nested resource resolves `#/...` refs against itself.
    if (!isSchemaRecord(value) || (!root && Object.hasOwn(value, '$id'))) return value;
    const mapped = mapSchemaChildren(value, child => rewrite(child, false));
    const name = typeof value.$ref === 'string' ? localDefinitionName(value.$ref) : undefined;
    const target = name === undefined ? undefined : aliases.get(name);
    if (target !== undefined) mapped.$ref = target;
    return mapped;
  };
  const rewritten = rewrite(schema, true) as SchemaRecord;
  const remaining = [...schemaReferences(rewritten).references];
  const definitions = Object.fromEntries(Object.entries(rewritten.$defs as SchemaRecord).filter(([name]) => {
    const pointer = `#/$defs/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    return !aliases.has(name) || remaining.some(reference => reference === pointer || reference.startsWith(`${pointer}/`));
  }));
  return { ...rewritten, $defs: definitions };
}

/** Keywords whose subschema Ajv validates once per element of an array or object. */
const PER_ELEMENT_KEYWORDS = new Set(['items', 'prefixItems', 'additionalProperties', 'patternProperties', 'contains']);
/** Keywords that apply a subschema to the same instance, so the instance's position carries over. */
const SAME_INSTANCE_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']);

/**
 * Ajv inlines a `$ref` target only when the target has no `$ref` of its own, so
 * a model item in an array otherwise costs a sub-validator call per element.
 * Substitute a target that is reached in a per-element position (array items,
 * pattern or additional properties), is not part of a reference cycle, is not
 * a residual schema, and holds no name or base that would change meaning in its
 * new resource. A model used as a plain property is called once per instance, so
 * inlining it would only copy its body. The body of an inlined target keeps its
 * own refs: nesting copies would grow the code with the depth of the model graph.
 * Every other `$ref` stays. Applied to the schemas Ajv compiles;
 * the schema data the plan returns is unchanged.
 */
function inlineAcyclicModelRefs(declared: Readonly<Record<string, object | boolean>>): Record<string, object | boolean> {
  const ids = new Set(Object.keys(declared));
  const schemas = Object.fromEntries(Object.entries(declared).map(([id, schema]) => [id, resolveDefinitionAliases(schema, ids)]));
  const analyses = new Map<string, SchemaReferences>();
  for (const [id, schema] of Object.entries(schemas)) {
    if (isSchemaRecord(schema)) analyses.set(id, schemaReferences(schema));
  }
  const edges = new Map<string, ReadonlySet<string>>();
  for (const [id, analysis] of analyses) edges.set(id, new Set([...analysis.references].filter(reference => analyses.has(reference))));
  const cyclic = referenceCycleMembers(edges);
  const inlinable = new Set<string>();
  for (const [id, analysis] of analyses) {
    if (cyclic.has(id) || id.endsWith('#model-only') || id.endsWith('#wire-only') || analysis.resourceScoped) continue;
    if ([...analysis.references].every(reference => analyses.has(reference))) inlinable.add(id);
  }

  // `inlined` is true inside a substituted body: its own per-element refs stay refs,
  // so the copies a host holds never nest.
  const inline = (value: unknown, perElement: boolean, inlined: boolean, keepReference = false): unknown => {
    if (!isSchemaRecord(value)) return value;
    const reference = value.$ref;
    if (perElement && !inlined && !keepReference && typeof reference === 'string' && inlinable.has(reference)) {
      const { $id: _id, $schema: _schema, ...body } = schemas[reference] as SchemaRecord;
      const { $ref: _ref, ...siblings } = value;
      // A sibling that constrains the same keyword as the target cannot replace it.
      if (Object.keys(siblings).every(key => key !== '$id' && key !== '$schema'
        && (ANNOTATION_KEYWORDS.has(key) || !Object.hasOwn(body, key)))) {
        return {
          ...(inline(body, true, true) as SchemaRecord),
          ...visitChildren(siblings, perElement, inlined, false),
        };
      }
    }
    return visitChildren(value, perElement, inlined, Object.hasOwn(value, 'discriminator'));
  };
  const visitChildren = (node: SchemaRecord, perElement: boolean, inlined: boolean, discriminated: boolean): SchemaRecord => mapSchemaChildren(
    node,
    (child, keyword) => inline(
      child,
      PER_ELEMENT_KEYWORDS.has(keyword) || (perElement && SAME_INSTANCE_KEYWORDS.has(keyword)),
      inlined,
      // Ajv's discriminator reads its oneOf/anyOf branches as references.
      discriminated && (keyword === 'oneOf' || keyword === 'anyOf'),
    ),
  );
  return Object.fromEntries(Object.entries(schemas).map(([id, schema]) => [id, inline(schema, false, false) as object | boolean]));
}

function standaloneSource(input: StandaloneValidatorInput, allErrors: boolean): string {
  const addFormats: unknown = FormatsModule.default;
  const standalone: unknown = StandaloneModule.default;
  if (!isFormats(addFormats) || !isStandalone(standalone)) {
    throw new TypeError('Ajv tooling exports are unavailable.');
  }
  const ajv = new Ajv2020({ allErrors, strict: false, validateSchema: false, discriminator: true, code: { source: true } });
  addFormats(ajv);
  addModelKeywords(ajv);
  addValidationKeyword(ajv);
  for (const [id, schema] of Object.entries(input.schemas)) {
    ajv.addSchema(lowerDiscriminatorMappings(schema) as AnySchema, id);
  }
  const references = [...new Set(input.references)].sort();
  const exports = Object.fromEntries(references.map((reference, index) => [`v${index}`, reference]));
  for (const reference of references) {
    if (!ajv.getSchema(reference)) throw new Error(`Cannot compile schema: ${reference}`);
  }
  return standalone(ajv, exports);
}

/** Compile fast and all-error functions for each closed schema reference. Application functions are injected when a factory is called. */
export function compileStandaloneValidatorSet(input: StandaloneValidatorInput): StandaloneValidatorOutput {
  const references = [...new Set(input.references)].sort();
  const compiled = { ...input, schemas: inlineAcyclicModelRefs(input.schemas) };
  const source = standaloneSource(compiled, true);
  const firstSource = standaloneSource(compiled, false);
  // Computed properties keep schema identities such as `__proto__` as own data
  // keys instead of invoking the object-literal prototype setter.
  const referenceMap = references.map((reference, index) => `[${JSON.stringify(reference)}]: exports.v${index}`).join(',');
  const allFactory = `export function createValidators(bindings = {}) {\nconst exports = {};\n${source}\nreturn {${referenceMap}};\n}`;
  const schemaData = JSON.stringify(input.schemas);
  if (schemaData === undefined) throw new TypeError('Standalone schema data is not JSON serializable.');
  const codeSource = `${allFactory}\nexport function createValidatorSet(bindings = {}) {\nconst schemas = JSON.parse(${JSON.stringify(schemaData)});\nconst first = (() => { const exports = {}; ${firstSource}\nreturn {${referenceMap}}; })();\nconst all = createValidators(bindings);\nreturn { first, all, schemas };\n}`;
  const resolveDir = path.dirname(createRequire(import.meta.url).resolve('ajv/package.json'));
  const result = buildSync({
    absWorkingDir: resolveDir,
    stdin: {
      contents: codeSource,
      resolveDir,
      sourcefile: 'validators.generated.js',
      loader: 'js',
    },
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
    metafile: true, legalComments: 'inline',
  });
  if (!result.outputFiles?.[0]) throw new Error('Standalone validator compilation produced no output.');
  if (Object.values(result.metafile?.outputs ?? {}).some(output => output.imports.some(item => item.external))) {
    throw new Error('Standalone validators must not retain external imports.');
  }
  const require = createRequire(import.meta.url);
  const licenses = ['ajv', 'ajv-formats', 'fast-deep-equal'].map(name => {
    const directory = path.dirname(require.resolve(`${name}/package.json`));
    const license = ['LICENSE', 'LICENSE.md'].map(filename => path.join(directory, filename)).find(filename => fs.existsSync(filename));
    if (!license) throw new Error(`Missing bundled dependency license: ${name}`);
    return `${name}\n${fs.readFileSync(license, 'utf8')}`;
  });
  const banner = `/* Generated by ${input.owner}. Do not edit. */\n`;
  const setDeclaration = `export interface StandaloneValidatorSet { readonly first: Readonly<Record<string, ModelRuntimeSyncValidator>>; readonly all: Readonly<Record<string, ModelRuntimeSyncValidator>>; readonly schemas: Readonly<Record<string, object | boolean>>; }\nexport declare function createValidatorSet(bindings?: Readonly<Record<string, (value: unknown) => boolean | string>>): StandaloneValidatorSet;\n`;
  return {
    code: banner + result.outputFiles[0].text,
    declarations: banner + `import type { ModelRuntimeValidator, ModelRuntimeSyncValidator } from '@exprtlabs/golem/model';\nexport declare function createValidators(bindings?: Readonly<Record<string, (value: unknown) => boolean | string>>): Readonly<Record<string, ModelRuntimeValidator>>;\n${setDeclaration}`,
    notices: banner + licenses.join('\n\n'),
  };
}

