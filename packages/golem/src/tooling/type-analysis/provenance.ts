import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as ts from '../typescript-ns.js';
import {
  MODEL_MANIFEST_MARKER,
  discoverModelManifests,
  isGolemModeManifest,
  readModelManifest,
} from '../model-manifest-core.js';
import type {
  GolemModeManifest,
  ModelManifest,
  ModelManifestEntry,
} from '../model-manifest-core.js';
import { canonicalPath, displayPath, type GolemProfile, type InputObserver } from '../generator-core.js';
import type { CodecSchemaClosureEntry } from '../validation-plan.js';
import type { ModelTypeDescriptor } from '../../model-registry.js';
import { canonicalFilename, isUnderOutputs } from './project.js';
import type { ProgramInfo } from './project.js';

export interface ResolvedModelManifestEntry extends ModelManifestEntry {
  readonly manifestFile: string;
  /** OpenAPI entries advertise the effective any policy used for this model. */
  readonly allowAny: boolean;
}

export interface ManifestIndex {
  /** Every entry, by the module and export of its declaration. */
  readonly byProvenance: ReadonlyMap<string, ResolvedModelManifestEntry>;
  readonly files: readonly string[];
  /** Manifests advertised by loaded sources or discovered under this job's src. */
  readonly localFiles: readonly string[];
  readonly validationSchemaClosure: readonly CodecSchemaClosureEntry[];
  /** The manifests of SDKs in golem mode: this job compiles their types with its own models. */
  readonly golemModeManifests: readonly { readonly file: string; readonly manifest: GolemModeManifest }[];
  /**
   * The descriptor that the manifest of a golem-mode SDK holds for a type the SDK declares, when it names no other schema.
   * It holds each schema it names inline, and `sdkNode` names the codec of the SDK that checks it: a model that holds the type
   * checks it with the SDK's validator. The root of a model over the type drops `sdkNode`, since its schema equals the SDK's.
   */
  sdkDescriptorForType(type: ts.Type): ModelTypeDescriptor | undefined;
}

/**
 * The descriptor of the SDK schema `name`, with each schema it names written inline, so a model over it converts the whole value
 * and its schema is the SDK's: equal schemas compile to one validator. A schema that reaches itself has no finite inline form: undefined.
 */
function inlineSdkDescriptor(manifest: GolemModeManifest, name: string, active: readonly string[]): ModelTypeDescriptor | undefined {
  const text = manifest.descriptors.find((entry) => entry.name === name)?.descriptor;
  if (text === undefined || active.includes(name)) return undefined;
  let complete = true;
  const inline = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(inline);
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const named = record.kind === 'generated-model' ? record.id : record.kind === 'reference' ? record.name : undefined;
    if (typeof named === 'string') {
      const { kind: _kind, id: _id, name: _name, projection: _projection, ...rest } = record;
      const target = inlineSdkDescriptor(manifest, named, [...active, name]);
      if (target === undefined) complete = false;
      return { ...target, ...(inline(rest) as object), sdkNode: manifest.codecIds[named] };
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, inline(item)]));
  };
  const descriptor = inline(JSON.parse(text)) as ModelTypeDescriptor;
  return complete ? descriptor : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function manifestProvenance(filename: string, moduleName: string, exportName: string): string {
  const modulePath = isAbsolute(moduleName)
    ? moduleName
    : resolve(dirname(filename), moduleName);
  return `${canonicalFilename(modulePath)}\0${exportName}`;
}

function validateManifestProfile(
  manifest: ModelManifest,
  filename: string,
  profile: GolemProfile,
): void {
  const advertised = manifest.profile;
  const expected = { mobx: profile.mobx, validation: profile.validation, allowAny: profile.allowAny ?? false, unknownFormats: profile.unknownFormats };
  const differing = (Object.keys(expected) as (keyof typeof expected)[])
    .filter((key) => advertised[key] !== expected[key])
    .map((key) => `${key}: manifest ${advertised[key] ?? 'not recorded'}, project ${expected[key]}`);
  if (differing.length > 0) {
    throw new Error(
      `Model manifest profile mismatch in ${displayPath(filename)}: ${differing.join('; ')}. The project expects `
      + `{ mobx: ${expected.mobx}, validation: ${expected.validation}, allowAny: ${expected.allowAny}, unknownFormats: ${expected.unknownFormats} }. `
      + 'Regenerate the SDK manifest with the same profile before model generation, or set the project to the manifest value in golem.yaml.',
    );
  }
}

const MARKER_PATTERN = new RegExp(`${escapeRegExp(MODEL_MANIFEST_MARKER)}\\s+([^\\s*]+)`);

/**
 * The manifest path that a comment of the file names after the marker. A comment sits between top-level statements, so each gap is
 * read: what trails the previous statement on its line and what leads the next token. A string or code that holds the marker text names none.
 */
function advertisedPath(file: ts.SourceFile): string | undefined {
  const { text } = file;
  // Most files, such as the library declarations, never hold the marker text; only a file that does is walked.
  if (!text.includes(MODEL_MANIFEST_MARKER)) return undefined;
  for (const position of [0, ...file.statements.map((statement) => statement.end)]) {
    const comments = [...ts.getLeadingCommentRanges(text, position) ?? [], ...position === 0 ? [] : ts.getTrailingCommentRanges(text, position) ?? []];
    for (const { pos, end } of comments) {
      const marker = MARKER_PATTERN.exec(text.slice(pos, end));
      if (marker) return marker[1];
    }
  }
  return undefined;
}

/**
 * The manifests the program's files advertise with the `@golem-model-manifest` marker comment. Throws for one that does not exist.
 * A manifest under `laterOutputs` (canonical paths) is left out: a later job of the run writes it.
 */
export function advertisedModelManifests(program: ts.Program, onInput?: InputObserver, laterOutputs: readonly string[] = []): Set<string> {
  const advertised = new Set<string>();
  for (const sourceFile of program.getSourceFiles()) {
    const manifestPath = advertisedPath(sourceFile);
    if (manifestPath === undefined) continue;
    const filename = canonicalFilename(resolve(dirname(sourceFile.fileName), manifestPath));
    if (isUnderOutputs(laterOutputs, filename)) continue;
    onInput?.(filename);
    if (!existsSync(filename)) {
      throw new Error(
        `${displayPath(sourceFile.fileName)}: generated types advertise a missing model manifest: ${displayPath(filename)}. Run golem generate to write it, or reinstall the package that ships it.`,
      );
    }
    advertised.add(filename);
  }
  return advertised;
}

/** The manifest entry that lists a declaration of `symbol`. A published package ships `.d.ts` for the `.ts` file its manifest names. */
export function manifestModelOfSymbol(
  byProvenance: ReadonlyMap<string, ResolvedModelManifestEntry>,
  symbol: ts.Symbol,
): ResolvedModelManifestEntry | undefined {
  for (const declaration of symbol.declarations ?? []) {
    const file = canonicalFilename(declaration.getSourceFile().fileName);
    const model = byProvenance.get(`${file}\0${symbol.getName()}`)
      ?? byProvenance.get(`${file.replace(/\.d\.([cm]?ts)$/, '.$1')}\0${symbol.getName()}`);
    if (model) return model;
  }
  return undefined;
}

/**
 * The real files that a model manifest lists as the declaration of an SDK model. A job uses the SDK's generated code for them.
 * A published package ships `x.model.d.ts` for the `x.model.ts` its manifest names, so both forms count.
 */
export function sdkModelFiles(manifestIndex: ManifestIndex): ReadonlySet<string> {
  const files = new Set<string>();
  for (const key of manifestIndex.byProvenance.keys()) {
    const module = canonicalPath(key.slice(0, key.indexOf('\0')));
    files.add(module);
    files.add(module.replace(/(?<!\.d)\.([cm]?)ts$/, '.d.$1ts'));
  }
  return files;
}

/**
 * The model manifests of a job: the ones its root holds and its program advertises, then `explicit`. A manifest under
 * `laterOutputs` (where the jobs after this one write) is not read: this run rewrites it, and its profile and models from the
 * run before would make a clean run and a second run differ.
 */
export function loadModelManifests(
  root: string,
  info: ProgramInfo,
  explicit: readonly string[],
  profile: GolemProfile,
  onInput?: InputObserver,
  laterOutputs: readonly string[] = [],
): ManifestIndex {
  const outputs = laterOutputs.map(canonicalPath);
  const advertised = advertisedModelManifests(info.program, onInput, outputs);
  const discovered = discoverModelManifests(root, (filename) => { if (!isUnderOutputs(outputs, filename)) onInput?.(filename); })
    .map(canonicalFilename)
    .filter((filename) => !isUnderOutputs(outputs, filename));
  discovered.forEach((filename) => onInput?.(filename));
  const localFiles = [...new Set([...discovered, ...advertised])].sort();
  const local = new Set(localFiles);
  const filenames = [...new Set([
    ...localFiles,
    ...explicit.map(canonicalFilename),
  ])].sort();
  const byProvenance = new Map<string, ResolvedModelManifestEntry>();
  // Every id of every manifest, an SDK type's included, so that two manifests cannot share one.
  const manifestOfId = new Map<string, string>();
  const validationSchemaClosure: CodecSchemaClosureEntry[] = [];
  const golemModeManifests: { file: string; manifest: GolemModeManifest }[] = [];
  // The descriptor of each SDK type of a golem-mode manifest, with the schemas it names inline, by the provenance of its declaration.
  const sdkDescriptors = new Map<string, ModelTypeDescriptor>();
  for (const filename of filenames) {
    // Explicit SDK manifests stay in the load set for duplicate-id and profile
    // checks. Only manifests this job discovered or advertised are watch inputs
    // until emit records the ones it actually referenced.
    if (local.has(filename)) onInput?.(filename);
    if (!existsSync(filename)) throw new Error(`Model manifest does not exist: ${displayPath(filename)}`);
    const manifest = readModelManifest(filename);
    validateManifestProfile(manifest, filename, profile);
    validationSchemaClosure.push(...manifest.validationSchemaClosure ?? []);
    if (isGolemModeManifest(manifest)) golemModeManifests.push({ file: filename, manifest });
    for (const model of manifest.models) {
      const existingFile = manifestOfId.get(model.id);
      if (existingFile) {
        throw new Error(
          `Duplicate model manifest id "${model.id}" in ${existingFile} and ${filename}.`,
        );
      }
      if (typeof model.allowAny !== 'boolean') {
        throw new Error(
          `Invalid model manifest ${filename}: model ${model.id} must advertise an effective allowAny boolean.`,
        );
      }
      manifestOfId.set(model.id, filename);
      const resolved: ResolvedModelManifestEntry = { ...model, allowAny: model.allowAny, manifestFile: filename };
      const provenances = [model.type, ...(model.type.aliases ?? [])];
      for (const provenance of provenances) {
        const key = manifestProvenance(filename, provenance.module, provenance.export);
        const existing = byProvenance.get(key);
        if (existing) {
          throw new Error(
            `Ambiguous model provenance "${provenance.export}" in `
            + `${existing.manifestFile} and ${filename}.`,
          );
        }
        byProvenance.set(key, resolved);
      }
      if (isGolemModeManifest(manifest)) {
        const name = Object.keys(manifest.codecIds).find((candidate) => manifest.codecIds[candidate] === model.codecId);
        const descriptor = name === undefined ? undefined : inlineSdkDescriptor(manifest, name, []);
        if (descriptor !== undefined && name !== undefined) {
          for (const provenance of provenances) {
            sdkDescriptors.set(manifestProvenance(filename, provenance.module, provenance.export), { ...descriptor, sdkNode: manifest.codecIds[name] });
          }
        }
      }
    }
  }

  return {
    byProvenance,
    files: filenames,
    localFiles,
    validationSchemaClosure,
    golemModeManifests,
    sdkDescriptorForType(type: ts.Type): ModelTypeDescriptor | undefined {
      for (const symbol of [type.aliasSymbol, type.getSymbol?.()]) {
        for (const declaration of symbol?.declarations ?? []) {
          const file = canonicalFilename(declaration.getSourceFile().fileName);
          const found = sdkDescriptors.get(`${file}\0${symbol!.getName()}`)
            ?? sdkDescriptors.get(`${file.replace(/\.d\.([cm]?ts)$/, '.$1')}\0${symbol!.getName()}`);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    },
  };
}
