import { lowerDiscriminatorMappings } from '../discriminator-mapping.js';
import { GENERATED_MODEL_SCHEMA_REF_PREFIX, MODEL_INSTANCE_KEYWORD } from '../schema-keywords.js';
import { compareText, type GolemDiagnostic, type GolemProfile } from './generator-core.js';
import { codecShortName, type SchemaGraph, type SchemaNode } from './schema-graph.js';
import type { JsonSchema } from './schema.js';
import { compile, type CompileInput, type CompileOptions, type CompileResult, type SchemaPlace } from './validator-compiler/index.js';

export type { SchemaPlace };

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
  /** Whether the model reaches a recursive model. An entry without it counts as recursive. */
  readonly recursive?: boolean;
}

export interface CodecValidationPlan {
  readonly schemas: Readonly<Record<string, object | boolean>>;
  readonly references: readonly string[];
  /** Ids of the schemas built from the graphs, as opposed to manifest closure and tag schemas. */
  readonly ownSchemas: readonly string[];
  /** The model name behind each own schema id, with its `#wire`, `#model-only` and `#wire-only` forms. */
  readonly modelNames: Readonly<Record<string, string>>;
}

/** The level a validators module compiles at: a sanity project checks the shape only, any other writes one module that can check everything. */
export function compileLevel(validation: GolemProfile['validation']): 'full' | 'sanity' {
  return validation === 'sanity' ? 'sanity' : 'full';
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
 * that reference it leave its structure open. A model never validates above its project, so a project that does not
 * validate compiles none.
 */
function compiledCodecIds(
  nodes: readonly { readonly node: SchemaNode; readonly graph: SchemaGraph }[],
  defaultValidation: GolemProfile['validation'],
): ReadonlySet<string> {
  const own = new Map<string, { readonly node: SchemaNode; readonly graph: SchemaGraph }>();
  for (const entry of nodes) {
    if (entry.node.kind !== 'reference') own.set(entry.node.codecId, entry);
  }
  const compiled = new Set<string>();
  const pending = defaultValidation === false ? [] : [...own.values()].filter(({ node }) => node.validation !== false);
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    if (compiled.has(entry.node.codecId)) continue;
    compiled.add(entry.node.codecId);
    for (const edge of entry.node.edges) {
      const reached = entry.graph.nodes.get(edge);
      if (reached === undefined) continue;
      // A reference node stands for the codec another graph of the job owns.
      const target = reached.kind === 'reference' ? own.get(reached.codecId) : { node: reached, graph: entry.graph };
      if (target !== undefined && target.node.validation !== false) pending.push(target);
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
  /** The level of a node that does not choose: the profile's `validation`. */
  defaultValidation: GolemProfile['validation'] = true,
): CodecValidationPlan {
  const graphs = Array.isArray(graphOrGraphs) ? graphOrGraphs : [graphOrGraphs];
  const nodes = graphs.flatMap(graph => [...graph.nodes.values()]
    .map(node => ({ graph, node })))
    .sort((left, right) => compareText(left.node.codecId, right.node.codecId) || compareText(left.node.id, right.node.id));
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
  const modelNames: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const { graph, node } of nodes) {
    if (node.kind === 'reference' || !compiled.has(node.codecId)) continue;
    const own = (id: string): void => {
      ownSchemas.add(id);
      modelNames[id] = node.name;
    };
    own(node.codecId);
    if (!node.sameSchema) own(`${node.codecId}#wire`);
    if (node.modelOnlyJsonSchema !== undefined) own(`${node.codecId}#model-only`);
    if (node.wireOnlyJsonSchema !== undefined) own(`${node.codecId}#wire-only`);
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
  for (const [id, schema] of Object.entries(additionalSchemas).sort(([left], [right]) => compareText(left, right))) {
    addSchema(id, schema);
  }

  /** The one codec id a model name stands for, from `preferredAliases` or the whole plan; a name that is a schema id is its own. Undefined when none does. `place` names the caller in the ambiguity error. */
  const codecIdOf = (name: string, preferredAliases: Map<string, Set<string>> | undefined, place: string): string | undefined => {
    if (Object.hasOwn(schemas, name)) return name;
    const candidates = preferredAliases?.get(name)
      ?? preferredAliases?.get(codecShortName(name))
      ?? aliases.get(name)
      ?? aliases.get(codecShortName(name));
    if (candidates && candidates.size > 1) {
      throw new TypeError(
        `Cannot compile validators: ${place} ${JSON.stringify(name)} `
        + `is ambiguous between codec identities ${[...candidates].sort().map(id => JSON.stringify(id)).join(', ')}. `
        + 'Regenerate the referenced model manifest with an unambiguous codec identity.',
      );
    }
    return candidates?.values().next().value;
  };

  /** A `golemModelInstance` value with each model name replaced by its codec id, which a class registers under: the generated check compares ids exactly. A name no model answers to stays. */
  const withInstanceCodecIds = (instance: unknown, preferredAliases: Map<string, Set<string>> | undefined): unknown => {
    if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) return instance;
    const { of, among } = instance as { of?: unknown; among?: unknown };
    const idOf = (name: unknown): unknown => (typeof name === 'string' ? codecIdOf(name, preferredAliases, `the ${MODEL_INSTANCE_KEYWORD} model name`) ?? name : name);
    return { ...instance, ...(of === undefined ? {} : { of: idOf(of) }), ...(Array.isArray(among) ? { among: among.map(idOf) } : {}) };
  };

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
            const codecId = codecIdOf(name, preferredAliases, 'generated model schema reference');
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
          if (key === MODEL_INSTANCE_KEYWORD) {
            result[key] = withInstanceCodecIds(item, preferredAliases);
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
  return { schemas, references: Object.keys(schemas).sort(), ownSchemas: [...ownSchemas].sort(), modelNames };
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
  /** What the module checks (see `compileLevel`); every check by default. */
  readonly level?: 'full' | 'sanity';
  /** The roots the module exports (see `CompileOptions.emitRoots`); every root by default. */
  readonly emitRoots?: ReadonlySet<string>;
  /** The user validation functions the schemas name, with import paths relative to the validators file. */
  readonly validations?: CompileInput['validations'];
  /** Named in each diagnostic message that `locate` does not place. */
  readonly documentName: string;
  /** Maps a schema resource and a JSON Pointer inside it to the place the user knows. */
  readonly locate?: CompileOptions['locate'];
  /** Maps a model name to the place the user knows; a model is named by default. A model schema adds its own structure, so no pointer inside it is a place. */
  readonly locateModel?: (name: string) => SchemaPlace;
  /** Where the module imports its runtime values and their types from (see `CompileOptions.specifiers`); the package's own entries by default. */
  readonly specifiers?: CompileOptions['specifiers'];
}

export interface PlanValidators {
  /** The validators module (TypeScript), empty when a diagnostic is an error. */
  readonly source: string;
  /** The name each root is exported under, by root name; see `CompileResult.exports`. */
  readonly exports: ReadonlyMap<string, string>;
  /** The name each model plan root's fast check is exported under, for the roots that have one; see `CompileResult.fastExports`. */
  readonly fastExports: ReadonlyMap<string, string>;
  /** The names each model plan root's structure check and predicates-only pass are exported under, for the roots that have them; see `CompileResult.passExports`. */
  readonly passExports: CompileResult['passExports'];
  readonly diagnostics: readonly GolemDiagnostic[];
}

/** Compiles `roots` and `resources` to one validators module (TypeScript). */
function compileValidatorRoots(
  roots: ReadonlyMap<string, unknown>,
  resources: ReadonlyMap<string, unknown>,
  options: PlanValidatorsOptions,
  fastRoots: ReadonlySet<string>,
): PlanValidators {
  const { source, exports, fastExports, passExports, diagnostics } = compile(
    {
      roots,
      ...(resources.size === 0 ? {} : { resources }),
      ...(options.validations === undefined ? {} : { validations: options.validations }),
    },
    {
      unknownFormats: options.unknownFormats,
      documentName: options.documentName,
      typed: true,
      fastPath: fastRoots,
      ...(options.level === undefined ? {} : { level: options.level }),
      ...(options.emitRoots === undefined ? {} : { emitRoots: options.emitRoots }),
      ...(options.locate === undefined ? {} : { locate: options.locate }),
      ...(options.specifiers === undefined ? {} : { specifiers: options.specifiers }),
    },
  );
  const banner = `/* Generated by ${options.owner}. Do not edit. */\n`;
  return {
    source: source === '' ? '' : `${banner}// @ts-nocheck\n${source}`,
    exports,
    fastExports,
    passExports,
    diagnostics,
  };
}

/**
 * The roots that compile a plan: each schema under its plan id. A root's own `$id` (the id again, `#wire` fragment
 * included) would move the base URI of the root's local `$ref`s onto the model root of the same codec, so the
 * compiler does not see it.
 */
function planValidationRoots(plan: CodecValidationPlan): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(plan.schemas).map(([id, schema]) => [id, withoutOwnId(lowerDiscriminatorMappings(schema), id)] as const));
}

/** Compile every schema of the plan to one validators module; each id of the plan is a root name of the result's `exports`. */
export function compilePlanValidators(plan: CodecValidationPlan, options: PlanValidatorsOptions): PlanValidators {
  const locateModel = options.locateModel ?? ((name: string): SchemaPlace => ({ where: `model ${name}` }));
  const roots = planValidationRoots(plan);
  // The codecs of the plan's own models answer a valid value with the fast check; tag and closure roots get none, as no codec asserts them.
  return compileValidatorRoots(roots, new Map(), {
    ...options,
    locate: (resource, pointer) => {
      const name = plan.modelNames[resource];
      return name === undefined ? options.locate?.(resource, pointer) : locateModel(name);
    },
  }, new Set(plan.ownSchemas));
}

/** The diagnostics without repeats: one schema that several compilations reach reports once. */
export function uniqueDiagnostics(diagnostics: readonly GolemDiagnostic[]): readonly GolemDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter(diagnostic => {
    const key = `${diagnostic.code}\0${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface SdkValidatorsInput {
  /** The validation plan of every model of the SDK, in one graph. */
  readonly plan?: CodecValidationPlan;
  /**
   * Each operation's roots, one for the input and one for each response, by root name, and the schemas those reach
   * only through `$ref`, by name; a resource keeps its `$id`. A resource that several operations hold must be the
   * same schema in each.
   */
  readonly operations: readonly {
    readonly roots: Readonly<Record<string, unknown>>;
    readonly resources: Readonly<Record<string, unknown>>;
  }[];
}

function sameSchema(first: unknown, second: unknown): boolean {
  return first === second || JSON.stringify(first) === JSON.stringify(second);
}

/**
 * Compile the roots of every model and every operation of an SDK to one validators module. A root name belongs to
 * one schema: a name that an operation root and a model root both take, or that two operations' resources take with
 * different schemas, is an error rather than a silent rename. Roots whose names only become the same identifier are
 * told apart by the compiler (`CompileResult.exports`). Every check is written once across the models and the
 * operations.
 */
export function compileSdkValidators(input: SdkValidatorsInput, options: PlanValidatorsOptions): PlanValidators {
  const roots = new Map<string, unknown>(input.plan ? planValidationRoots(input.plan) : []);
  // A schema that several operations share is lowered once, so the comparison below finds it the same object.
  const loweredSchemas = new Map<unknown, unknown>();
  const lowerOnce = (schema: unknown): unknown => {
    if (!loweredSchemas.has(schema)) loweredSchemas.set(schema, lowerDiscriminatorMappings(schema));
    return loweredSchemas.get(schema);
  };
  const lowered = (schemas: Readonly<Record<string, unknown>>): Map<string, unknown> =>
    new Map(Object.entries(schemas).map(([name, schema]) => [name, lowerOnce(schema)] as const));
  const resources = new Map<string, unknown>();
  for (const operation of input.operations) {
    for (const [name, root] of lowered(operation.roots)) {
      if (roots.has(name)) throw new Error(`Cannot compile the SDK validators: the operation root ${JSON.stringify(name)} has the name of another root.`);
      roots.set(name, root);
    }
    for (const [name, resource] of lowered(operation.resources)) {
      if (resources.has(name) && !sameSchema(resources.get(name), resource)) {
        throw new Error(`Cannot compile the SDK validators: two operations give the resource ${JSON.stringify(name)} different schemas.`);
      }
      resources.set(name, resource);
    }
  }
  for (const name of resources.keys()) {
    if (roots.has(name)) throw new Error(`Cannot compile the SDK validators: the resource ${JSON.stringify(name)} has the name of a root.`);
  }
  const locateModel = options.locateModel ?? ((name: string): SchemaPlace => ({ where: `model ${name}` }));
  // The plan's own model roots get fast checks; the operation validators do not.
  return compileValidatorRoots(roots, resources, {
    ...options,
    locate: (resource, pointer) => {
      const name = input.plan?.modelNames[resource];
      return name === undefined ? options.locate?.(resource, pointer) : locateModel(name);
    },
  }, new Set(input.plan?.ownSchemas ?? []));
}
