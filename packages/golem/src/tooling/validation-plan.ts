import { lowerDiscriminatorMappings } from '../discriminator-mapping.js';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX } from '../schema-keywords.js';
import type { GolemDiagnostic } from './generator-api.js';
import { codecShortName, type SchemaGraph, type SchemaNode } from './schema-graph.js';
import type { JsonSchema } from './schema.js';
import { compile, type CompileInput } from './validator-compiler/index.js';

/** Schema data copied from a generated-model manifest, so a job closes over the models it references. */
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
  /** Ids of the schemas built from the graphs, as opposed to manifest closure and tag schemas. */
  readonly ownSchemas: readonly string[];
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

export function localDefinitionName(reference: string): string | undefined {
  const prefix = '#/$defs/';
  if (!reference.startsWith(prefix)) return undefined;
  const segment = reference.slice(prefix.length);
  if (segment.length === 0 || segment.includes('/')) return undefined;
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
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
      `Schema identity ${JSON.stringify(schema.$id)} conflicts with codec identity ${JSON.stringify(id)}.`,
    );
  }
  return { ...schema, $id: id };
}

function schemaNodeAliases(node: SchemaNode): readonly string[] {
  return [...new Set([node.codecId, node.id, node.name, codecShortName(node.name)])];
}

/**
 * The codecs the plan compiles: those that validate, and the reachable codecs that did not choose, which a validating
 * model's schema references by id (as the runtime path did). A codec that sets `validation: false` stays out: the schemas
 * that reference it leave its structure open.
 */
function compiledCodecIds(
  nodes: readonly { readonly node: SchemaNode; readonly graph: SchemaGraph }[],
  defaultValidation: boolean,
): ReadonlySet<string> {
  const own = new Map<string, { readonly node: SchemaNode; readonly graph: SchemaGraph }>();
  for (const entry of nodes) {
    if (entry.node.kind !== 'reference') own.set(entry.node.codecId, entry);
  }
  const compiled = new Set<string>();
  const pending = [...own.values()].filter(({ node }) => node.validationEnabled ?? defaultValidation);
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    if (compiled.has(entry.node.codecId)) continue;
    compiled.add(entry.node.codecId);
    for (const edge of entry.node.edges) {
      const reached = entry.graph.nodes.get(edge);
      if (reached === undefined) continue;
      // A reference node stands for the codec another graph of the job owns.
      const target = reached.kind === 'reference' ? own.get(reached.codecId) : { node: reached, graph: entry.graph };
      if (target !== undefined && target.node.validationEnabled !== false) pending.push(target);
    }
  }
  return compiled;
}

/**
 * Build the complete data-only schema set for generated object codecs.
 * Generated-model placeholder refs are resolved while generation still has
 * graph and manifest identity; the emitted runtime never discovers schemas.
 */
export function buildCodecValidationPlan(
  graphOrGraphs: SchemaGraph | readonly SchemaGraph[],
  externalCodecs: readonly CodecSchemaClosureEntry[] = [],
  additionalSchemas: Readonly<Record<string, JsonSchema>> = {},
  /** Whether a node that does not choose validates: the profile's `validation`. */
  defaultValidation = true,
): CodecValidationPlan {
  const graphs = Array.isArray(graphOrGraphs) ? graphOrGraphs : [graphOrGraphs];
  const nodes = graphs.flatMap(graph => [...graph.nodes.values()]
    .map(node => ({ graph, node })))
    .sort((left, right) => left.node.codecId.localeCompare(right.node.codecId) || left.node.id.localeCompare(right.node.id));
  const compiled = compiledCodecIds(nodes, defaultValidation);
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
      if (compiled.has(node.codecId)) {
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
        throw new TypeError(`Conflicting schema identity ${JSON.stringify(id)}.`);
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
  const ownSchemas = new Set<string>();
  for (const { graph, node } of nodes) {
    if (node.kind === 'reference' || !compiled.has(node.codecId)) continue;
    ownSchemas.add(node.codecId);
    if (!node.sameSchema) ownSchemas.add(`${node.codecId}#wire`);
    if (node.modelOnlyJsonSchema !== undefined) ownSchemas.add(`${node.codecId}#model-only`);
    if (node.wireOnlyJsonSchema !== undefined) ownSchemas.add(`${node.codecId}#wire-only`);
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
      if (active.has(current)) throw new TypeError('Cyclic schema data cannot be compiled into validators.');
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
                `Cannot compile validators: generated model schema reference ${JSON.stringify(name)} `
                + `is ambiguous between codec identities ${[...candidates].sort().map(id => JSON.stringify(id)).join(', ')}. `
                + 'Regenerate the referenced model manifest with an unambiguous codec identity.',
              );
            }
            const codecId = candidates?.values().next().value;
            if (codecId === undefined || !Object.hasOwn(schemas, codecId)) {
              throw new TypeError(
                `Cannot compile validators: generated model schema reference ${JSON.stringify(name)} is unresolved. `
                + 'Regenerate the referenced model manifest with schema closure metadata.',
              );
            }
            if (residualPlane !== undefined) {
              if (!Object.hasOwn(schemas, `${codecId}${residualPlane}`)) {
                throw new TypeError(
                  `Cannot compile validators: residual schema ${JSON.stringify(`${codecId}${residualPlane}`)} is unresolved. `
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
  return { schemas, references: Object.keys(schemas).sort(), ownSchemas: [...ownSchemas].sort() };
}

function withoutOwnId(schema: unknown, id: string): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema) || Reflect.get(schema, '$id') !== id) return schema;
  const copy = { ...(schema as Record<string, unknown>) };
  delete copy.$id;
  return copy;
}

export interface PlanValidatorsOptions {
  /** The package that writes the file: its name opens the file's ownership header. */
  readonly owner: string;
  readonly unknownFormats: 'warn' | 'error';
  /** The user validation functions the schemas name, with import paths relative to the validators file. */
  readonly validations?: CompileInput['validations'];
  /** Named in every diagnostic message. */
  readonly documentName: string;
}

export interface PlanValidators {
  /** The validators module (TypeScript), empty when a diagnostic is an error. */
  readonly source: string;
  readonly diagnostics: readonly GolemDiagnostic[];
}

function compileRoots(
  roots: ReadonlyMap<string, unknown>,
  resources: ReadonlyMap<string, unknown>,
  options: PlanValidatorsOptions,
): PlanValidators {
  const { source, diagnostics } = compile(
    {
      roots,
      ...(resources.size === 0 ? {} : { resources }),
      ...(options.validations === undefined ? {} : { validations: options.validations }),
    },
    { unknownFormats: options.unknownFormats, documentName: options.documentName, typed: true },
  );
  const banner = `/* Generated by ${options.owner}. Do not edit. */\n`;
  return {
    source: source === '' ? '' : `${banner}// @ts-nocheck\n${source}`,
    diagnostics,
  };
}

/** Compile every schema of the plan to one validators module; each id of the plan is a key of its `validators` export. */
export function compilePlanValidators(plan: CodecValidationPlan, options: PlanValidatorsOptions): PlanValidators {
  // A root is addressed by its plan id. Its own `$id` (the id again, `#wire` fragment included) would move the base
  // URI of the root's local `$ref`s onto the model root of the same codec, so the compiler does not see it.
  const roots = new Map(Object.entries(plan.schemas).map(([id, schema]) => [id, withoutOwnId(lowerDiscriminatorMappings(schema), id)] as const));
  return compileRoots(roots, new Map(), options);
}

/**
 * Compile `roots` to one validators module, each root name a key of its `validators` export. `resources` are the
 * schemas the roots reach only through `$ref`; a resource keeps its `$id`.
 */
export function compileSchemaValidators(
  input: { readonly roots: Readonly<Record<string, unknown>>; readonly resources: Readonly<Record<string, unknown>> },
  options: PlanValidatorsOptions,
): PlanValidators {
  const lowered = (schemas: Readonly<Record<string, unknown>>): Map<string, unknown> =>
    new Map(Object.entries(schemas).map(([name, schema]) => [name, lowerDiscriminatorMappings(schema)] as const));
  return compileRoots(lowered(input.roots), lowered(input.resources), options);
}
