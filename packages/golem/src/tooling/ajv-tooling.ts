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

function compileOutput(input: StandaloneValidatorInput, includeModes: boolean): StandaloneValidatorOutput {
  const references = [...new Set(input.references)].sort();
  const source = standaloneSource(input, true);
  const firstSource = includeModes ? standaloneSource(input, false) : undefined;
  // Computed properties keep schema identities such as `__proto__` as own data
  // keys instead of invoking the object-literal prototype setter.
  const referenceMap = references.map((reference, index) => `[${JSON.stringify(reference)}]: exports.v${index}`).join(',');
  const allFactory = `export function createValidators(bindings = {}) {\nconst exports = {};\n${source}\nreturn {${referenceMap}};\n}`;
  const schemaData = JSON.stringify(input.schemas);
  if (schemaData === undefined) throw new TypeError('Standalone schema data is not JSON serializable.');
  const codeSource = includeModes
    ? `${allFactory}\nexport function createValidatorSet(bindings = {}) {\nconst schemas = JSON.parse(${JSON.stringify(schemaData)});\nconst first = (() => { const exports = {}; ${firstSource}\nreturn {${referenceMap}}; })();\nconst all = createValidators(bindings);\nreturn { first, all, schemas };\n}`
    : allFactory;
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
  const setDeclaration = includeModes
    ? `export interface StandaloneValidatorSet { readonly first: Readonly<Record<string, ModelRuntimeSyncValidator>>; readonly all: Readonly<Record<string, ModelRuntimeSyncValidator>>; readonly schemas: Readonly<Record<string, object | boolean>>; }\nexport declare function createValidatorSet(bindings?: Readonly<Record<string, (value: unknown) => boolean | string>>): StandaloneValidatorSet;\n`
    : '';
  return {
    code: banner + result.outputFiles[0].text,
    declarations: banner + `import type { ModelRuntimeValidator${includeModes ? ', ModelRuntimeSyncValidator' : ''} } from '@exprtlabs/golem/model';\nexport declare function createValidators(bindings?: Readonly<Record<string, (value: unknown) => boolean | string>>): Readonly<Record<string, ModelRuntimeValidator>>;\n${setDeclaration}`,
    notices: banner + licenses.join('\n\n'),
  };
}

/** Compile schema data only. Application functions are injected when the factory is called. */
export function compileStandaloneValidators(input: StandaloneValidatorInput): StandaloneValidatorOutput {
  return compileOutput(input, false);
}

/** Compile fast and all-error functions for each closed schema reference. */
export function compileStandaloneValidatorSet(input: StandaloneValidatorInput): StandaloneValidatorOutput {
  return compileOutput(input, true);
}
