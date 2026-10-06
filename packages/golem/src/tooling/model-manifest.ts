import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { discoverSources, isRecord, resolveProfile } from './generator-api.js';
import type { GolemProfile, InputObserver } from './generator-api.js';
import type { CodecSchemaClosureEntry } from './validation-plan.js';

export interface ModelManifestProvenance {
  readonly module: string;
  readonly export: string;
  readonly aliases?: readonly ModelManifestProvenance[];
}

export interface ModelManifestEntry {
  readonly id: string;
  /** The runtime codec id a rewrite stamps for this model. Manifests written before it existed have none. */
  readonly codecId?: string;
  readonly allowAny: boolean;
  readonly type: ModelManifestProvenance;
  readonly generated: { readonly module: string; readonly export: string };
  readonly [key: string]: unknown;
}
export interface ModelManifest {
  readonly profile: GolemProfile;
  readonly models: readonly ModelManifestEntry[];
  readonly validationSchemaClosure?: readonly CodecSchemaClosureEntry[];
  readonly [key: string]: unknown;
}

export const MODEL_MANIFEST_FILENAME = 'model-manifest.json';
export const MODEL_MANIFEST_MARKER = '@golem-model-manifest';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

/** Return an identity projection that deliberately excludes generation profile. */
export function stableIdentity(value: unknown): unknown {
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
  return isRecord(profile) && ['mobx', 'validation', 'allowAny'].every(key => typeof profile[key] === 'boolean');
}

export function validateModelProfile(profile: unknown, filename = MODEL_MANIFEST_FILENAME): GolemProfile {
  if (!isRecord(profile)) {
    throw new Error(`Invalid model manifest ${filename}: profile must be an object.`);
  }
  if (!isProfile(profile)) {
    throw new Error(
      `Invalid model manifest ${filename}: profile must include mobx, validation and allowAny booleans. Regenerate the models.`,
    );
  }
  if (profile.unknownFormats !== undefined && profile.unknownFormats !== 'warn' && profile.unknownFormats !== 'error') {
    throw new Error(`Invalid model manifest ${filename}: profile unknownFormats must be "warn" or "error". Regenerate the models.`);
  }
  const unknown = Object.keys(profile).filter((key) => !['mobx', 'validation', 'allowAny', 'unknownFormats'].includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid model manifest ${filename}: profile has unsupported field(s): ${unknown.join(', ')}. Regenerate or remove the older generated SDK.`,
    );
  }
  return resolveProfile(profile);
}

export function modelManifestProfile(manifest: unknown, filename = MODEL_MANIFEST_FILENAME): GolemProfile {
  if (!isRecord(manifest)) {
    throw new Error(`Invalid model manifest ${filename}: expected an object.`);
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
    && (value.aliases === undefined || (Array.isArray(value.aliases) && value.aliases.every(alias => typeof alias === 'string' && alias.length > 0)));
}

export function validateModelManifest(manifest: unknown, filename = MODEL_MANIFEST_FILENAME): ModelManifest {
  if (!isRecord(manifest)) {
    throw new Error(`Invalid model manifest ${filename}: expected an object.`);
  }
  if ('manifestVersion' in manifest) {
    throw new Error(
      `Outdated model manifest in ${filename}: regenerate the models with the current generator.`,
    );
  }
  modelManifestProfile(manifest, filename);
  if (manifest.validationSchemaClosure !== undefined
    && (!Array.isArray(manifest.validationSchemaClosure) || !manifest.validationSchemaClosure.every(isClosureEntry))) {
    throw new Error(`Invalid model manifest ${filename}: validationSchemaClosure must contain codec ids and data-only model/wire schemas. Regenerate the models.`);
  }
  if (!Array.isArray(manifest.models)) {
    throw new Error(`Invalid model manifest ${filename}: models must be an array.`);
  }
  for (const model of manifest.models) {
    if (
      !isRecord(model) || !isProvenance(model.type) || !isProvenance(model.generated)
      || typeof model.id !== 'string' || !model.id || typeof model.allowAny !== 'boolean'
      || (model.codecId !== undefined && (typeof model.codecId !== 'string' || !model.codecId))
    ) {
      throw new Error(`Invalid model entry in ${filename}.`);
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
      `Could not read model manifest ${filename}: `
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

export function manifestMarker(relative = `./${MODEL_MANIFEST_FILENAME}`) {
  return `/* ${MODEL_MANIFEST_MARKER} ${relative} */`;
}
