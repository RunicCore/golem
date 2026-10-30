import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { discoverSources, displayPath, isRecord, isValidationLevel, resolveProfile, stableValue } from './generator-core.js';
import type { GolemProfile, InputObserver } from './generator-core.js';
import { createSchemaGraph, internDescriptors, type SchemaGraph } from './schema-graph.js';
import type { ModelTypeDescriptor } from './schema.js';
import type { CodecSchemaClosureEntry } from './validation-plan.js';

interface ModelManifestProvenance {
  readonly module: string;
  readonly export: string;
  readonly aliases?: readonly ModelManifestProvenance[];
}

export interface ModelManifestEntry {
  readonly id: string;
  /** The runtime codec id a rewrite stamps for this model. */
  readonly codecId: string;
  readonly allowAny: boolean;
  readonly type: ModelManifestProvenance;
  /** The module and class a generated model class is exported from; an entry of an SDK, which writes no model class, names none. */
  readonly generated?: { readonly module: string; readonly export: string };
  readonly [key: string]: unknown;
}
export interface ModelManifest {
  readonly profile: GolemProfile;
  readonly models: readonly ModelManifestEntry[];
  readonly validationSchemaClosure?: readonly CodecSchemaClosureEntry[];
  readonly [key: string]: unknown;
}

/**
 * The schema graph of a golem-mode SDK, as data. A descriptor is JSON text: the manifest file writes its keys in sorted order,
 * and the key order of a descriptor is part of the codec id of an unnamed shape, so the text keeps the order the graph interned.
 */
interface SdkDescriptorText {
  /** The name the graph interned the model or recursive alias under. */
  readonly name: string;
  readonly descriptor: string;
}

/** One operation value that converts something: where it sits, and its node. An inline shape (no `$ref`) also holds the descriptor the graph interned for it. */
export interface SdkOperationValue {
  /** The key of the value after the operation name: `['request', contentType]`, `['response', status, contentType]`, `['parameter', location, name]` or `['response-header', status, name]`. */
  readonly at: readonly string[];
  readonly node: string;
  readonly inline?: { readonly name?: string; readonly descriptor: string };
}

/**
 * The validators of one operation, as the data the models job compiles: the name of the root that checks the plain input, the header parameters, each response
 * body or stream item (key `status:contentType`) and each response header (key `status:name`), and the roots themselves. A root names its schema in the
 * manifest's `validationResources`.
 */
export interface SdkOperationValidation {
  readonly input: string;
  readonly headers?: string;
  readonly responses: readonly { readonly key: string; readonly root: string }[];
  readonly responseHeaders: readonly { readonly key: string; readonly root: string }[];
  readonly roots: Readonly<Record<string, unknown>>;
}

/** A manifest of an SDK in golem mode: the models job compiles the SDK types from these fields, and the manifest holds no `validationSchemaClosure`. */
export interface GolemModeManifest extends ModelManifest {
  readonly mode: 'golem';
  readonly dates: 'date' | 'temporal';
  /** The codec id of each model and recursive alias, by interned name. */
  readonly codecIds: Readonly<Record<string, string>>;
  /** In the order the graph interned them. */
  readonly descriptors: readonly SdkDescriptorText[];
  /** In the order the graph interned them. */
  readonly operations: readonly {
    readonly name: string;
    /** A webhook or callback: its request is decoded and its response encoded. */
    readonly inbound?: true;
    readonly values: readonly SdkOperationValue[];
    readonly validation?: SdkOperationValidation;
  }[];
  /** The models that each model narrows, by interned name; a model with none is absent. */
  readonly bases: Readonly<Record<string, readonly string[]>>;
  /** The schemas the operation roots reach, by resource id: one copy for all operations. Present when the SDK validates. */
  readonly validationResources?: Readonly<Record<string, unknown>>;
}

export function isGolemModeManifest(manifest: ModelManifest): manifest is GolemModeManifest {
  return manifest.mode === 'golem';
}

/**
 * The schema graph of a golem-mode SDK, sealed, made from the manifest's data: every model and recursive alias under its fixed
 * codec id, then every inline operation value. The graph is `openapi`-sourced, as the SDK's own was, so an unnamed shape gets the
 * node and codec id it had there; `valueNodes` gives the node of each operation value that converts something, by
 * `JSON.stringify([operation, ...at])`. A node the graph does not hold under the id the manifest recorded means the manifest and
 * this golem disagree, and stops with the regenerate message.
 */
export function sdkSchemaGraph(
  manifest: GolemModeManifest,
  validation: GolemProfile['validation'],
): { readonly graph: SchemaGraph; readonly valueNodes: ReadonlyMap<string, string> } {
  const graph = createSchemaGraph({}, { codecSource: 'openapi', codecIds: new Map(Object.entries(manifest.codecIds)) });
  const parse = (text: string): ModelTypeDescriptor => JSON.parse(text) as ModelTypeDescriptor;
  internDescriptors(graph, manifest.descriptors.map(({ name, descriptor }) => ({ name, descriptor: parse(descriptor), emitClass: false, validation })));
  const valueNodes = new Map<string, string>();
  for (const { name: operation, values } of manifest.operations) {
    for (const { at, node, inline } of values) {
      const id = inline ? graph.intern(parse(inline.descriptor), inline.name, false, validation).id : node;
      if (id !== node || !graph.nodes.has(id)) {
        throw new Error(`The SDK manifest of operation ${operation} names the schema node ${JSON.stringify(node)} for ${at.join(' ')}, which this golem does not rebuild. Regenerate the SDK with this golem version.`);
      }
      valueNodes.set(JSON.stringify([operation, ...at]), id);
    }
  }
  graph.seal();
  return { graph, valueNodes };
}

export const MODEL_MANIFEST_FILENAME = 'model-manifest.json';
export const MODEL_MANIFEST_MARKER = '@golem-model-manifest';

/** Return an identity projection that deliberately excludes generation profile. */
function stableIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const withoutProfile = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'profile'),
  );
  return stableValue(withoutProfile);
}

export function sourceDigest(value: unknown): string {
  return crypto.createHash('sha256')
    .update(`${JSON.stringify(stableIdentity(value), null, 2)}\n`)
    .digest('hex');
}

function isProfile(profile: unknown): profile is GolemProfile {
  return isRecord(profile) && ['mobx', 'allowAny'].every(key => typeof profile[key] === 'boolean') && isValidationLevel(profile.validation);
}

function validateModelProfile(profile: unknown, filename = MODEL_MANIFEST_FILENAME): GolemProfile {
  if (!isRecord(profile)) {
    throw new Error(`Invalid model manifest ${displayPath(filename)}: profile must be an object.`);
  }
  if (!isProfile(profile)) {
    throw new Error(
      `Invalid model manifest ${displayPath(filename)}: profile must include mobx, validation and allowAny booleans (validation may also be "sanity"). Regenerate the models.`,
    );
  }
  if (profile.unknownFormats !== undefined && profile.unknownFormats !== 'warn' && profile.unknownFormats !== 'error') {
    throw new Error(`Invalid model manifest ${displayPath(filename)}: profile unknownFormats must be "warn" or "error". Regenerate the models.`);
  }
  const unknown = Object.keys(profile).filter((key) => !['mobx', 'validation', 'allowAny', 'unknownFormats'].includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid model manifest ${displayPath(filename)}: profile has unsupported field(s): ${unknown.join(', ')}. Regenerate or remove the older generated SDK.`,
    );
  }
  return resolveProfile(profile);
}

function modelManifestProfile(manifest: unknown, filename = MODEL_MANIFEST_FILENAME): GolemProfile {
  if (!isRecord(manifest)) {
    throw new Error(`Invalid model manifest ${displayPath(filename)}: expected an object.`);
  }
  return validateModelProfile(manifest.profile, filename);
}

function isProvenance(value: unknown, visiting = new Set<object>()): value is ModelManifestProvenance {
  if (!isRecord(value) || typeof value.module !== 'string' || !value.module || typeof value.export !== 'string' || !value.export || visiting.has(value)) return false;
  if (value.aliases === undefined) return true;
  if (!Array.isArray(value.aliases)) return false;
  visiting.add(value);
  const valid = value.aliases.every(alias => isProvenance(alias, visiting));
  visiting.delete(value);
  return valid;
}

function isSchemaData(value: unknown, visiting = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || visiting.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  visiting.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every(item => isSchemaData(item, visiting));
  visiting.delete(value);
  return valid;
}

function isClosureEntry(value: unknown): value is CodecSchemaClosureEntry {
  return isRecord(value) && typeof value.codecId === 'string' && value.codecId.length > 0
    && (typeof value.modelSchema === 'boolean' || isRecord(value.modelSchema)) && isSchemaData(value.modelSchema)
    && [value.wireSchema, value.modelOnlySchema, value.wireOnlySchema].every((schema) =>
      schema === undefined || ((typeof schema === 'boolean' || isRecord(schema)) && isSchemaData(schema)))
    && (value.recursive === undefined || typeof value.recursive === 'boolean')
    && (value.aliases === undefined || (Array.isArray(value.aliases) && value.aliases.every(alias => typeof alias === 'string' && alias.length > 0)));
}

function isDescriptorText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.kind === 'string';
  } catch {
    return false;
  }
}

const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function isOperationValue(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.at) && value.at.length > 0 && value.at.every(isName) && isName(value.node)
    && (value.inline === undefined || (isRecord(value.inline) && isDescriptorText(value.inline.descriptor)
      && (value.inline.name === undefined || isName(value.inline.name))));
}

function isOperationValidation(value: unknown): boolean {
  const keyed = (items: unknown, member: string): boolean => Array.isArray(items) && items.every((item) => isRecord(item) && isName(item.key) && isName(item[member]));
  return isRecord(value) && isName(value.input) && (value.headers === undefined || isName(value.headers))
    && keyed(value.responses, 'root') && keyed(value.responseHeaders, 'root') && isRecord(value.roots);
}

/** A manifest with `mode: "golem"` carries the schema graph the models job compiles; one that lacks it was written by an older generator. */
function validateGolemModeGraph(manifest: Record<string, unknown>, filename: string): void {
  const invalid = (reason: string): Error => new Error(`Invalid model manifest ${displayPath(filename)}: ${reason}. Regenerate the SDK with this golem version.`);
  if (manifest.validationSchemaClosure !== undefined) throw invalid('a golem-mode manifest holds the schema graph, not validationSchemaClosure');
  if (manifest.dates !== 'date' && manifest.dates !== 'temporal') throw invalid('dates must be "date" or "temporal"');
  const { codecIds, descriptors, operations, bases } = manifest;
  if (!isRecord(bases) || !Object.values(bases).every((names) => Array.isArray(names) && names.every(isName))) throw invalid('bases must map each model to the names of the models it narrows');
  if (!isRecord(codecIds) || !Object.values(codecIds).every(isName)) throw invalid('codecIds must map each schema name to a codec id');
  if (!Array.isArray(descriptors) || !descriptors.every((entry) => isRecord(entry) && isName(entry.name) && isDescriptorText(entry.descriptor))) {
    throw invalid('descriptors must list each schema name with its descriptor as JSON text');
  }
  const unnamed = descriptors.find((entry) => !isName(codecIds[entry.name]));
  if (unnamed) throw invalid(`schema ${unnamed.name} has no codec id`);
  if (!Array.isArray(operations) || !operations.every((entry) => isRecord(entry) && isName(entry.name) && Array.isArray(entry.values) && entry.values.every(isOperationValue))) {
    throw invalid('operations must list each operation name with the nodes of its values');
  }
  const validating = manifest.profile !== undefined && isRecord(manifest.profile) && manifest.profile.validation !== false;
  if ((validating ? !operations.every((entry) => isOperationValidation(entry.validation)) : operations.some((entry) => entry.validation !== undefined)) || validating !== isRecord(manifest.validationResources)) {
    throw invalid('a validating SDK lists the validation roots of every operation and the resources they reach, and a non-validating SDK lists none');
  }
}

export function validateModelManifest(manifest: unknown, filename = MODEL_MANIFEST_FILENAME): ModelManifest {
  if (!isRecord(manifest)) {
    throw new Error(`Invalid model manifest ${displayPath(filename)}: expected an object.`);
  }
  if ('manifestVersion' in manifest) {
    throw new Error(
      `Outdated model manifest in ${displayPath(filename)}: regenerate the models with the current generator.`,
    );
  }
  modelManifestProfile(manifest, filename);
  if (manifest.mode !== undefined && manifest.mode !== 'golem') {
    throw new Error(`Invalid model manifest ${displayPath(filename)}: mode must be "golem" when present. Regenerate the SDK with this golem version.`);
  }
  if (manifest.mode === 'golem') validateGolemModeGraph(manifest, filename);
  if (manifest.validationSchemaClosure !== undefined
    && (!Array.isArray(manifest.validationSchemaClosure) || !manifest.validationSchemaClosure.every(isClosureEntry))) {
    throw new Error(`Invalid model manifest ${displayPath(filename)}: validationSchemaClosure must contain codec ids and data-only model/wire schemas. Regenerate the models.`);
  }
  if (!Array.isArray(manifest.models)) {
    throw new Error(`Invalid model manifest ${displayPath(filename)}: models must be an array.`);
  }
  for (const model of manifest.models) {
    if (
      !isRecord(model) || !isProvenance(model.type) || (model.generated !== undefined && !isProvenance(model.generated))
      || typeof model.id !== 'string' || !model.id || typeof model.allowAny !== 'boolean'
      || (model.codecId !== undefined && (typeof model.codecId !== 'string' || !model.codecId))
    ) {
      throw new Error(`Invalid model entry in ${displayPath(filename)}.`);
    }
    if (model.codecId === undefined) {
      throw new Error(`Invalid model manifest ${displayPath(filename)}: model entry ${model.type.export} has no codecId. Regenerate the SDK with this golem version.`);
    }
  }
  return manifest as ModelManifest;
}

export function readModelManifest(filename: string, onInput?: InputObserver): ModelManifest {
  onInput?.(path.resolve(filename));
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read model manifest ${displayPath(filename)}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateModelManifest(manifest, filename);
}

export function discoverModelManifests(root = process.cwd(), onInput?: InputObserver): string[] {
  // Build output may hold copied manifests; only source manifests count.
  return discoverSources(path.join(root, 'src'), {
    source: new RegExp(`^${MODEL_MANIFEST_FILENAME.replaceAll('.', '\\.')}$`),
    normalize: path.resolve,
    skip: directory => ['dist', 'build'].includes(path.basename(directory)),
    onInput: filename => { if (path.basename(filename) === MODEL_MANIFEST_FILENAME) onInput?.(filename); },
  });
}
