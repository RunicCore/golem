import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as ts from '../typescript-ns.js';
import {
  MODEL_MANIFEST_MARKER,
  discoverModelManifests,
  golemModeComponents,
  isGolemModeManifest,
  readModelManifest,
} from '../model-manifest-core.js';
import type {
  GolemModeManifest,
  ModelManifest,
  ModelManifestEntry,
} from '../model-manifest-core.js';
import { canonicalPath, compareText, displayPath, stableValue, type GolemProfile, type InputObserver } from '../generator-core.js';
import type { ModelTypeDescriptor } from '../../model-registry.js';
import { canonicalFilename, isUnderOutputs } from './project.js';
import type { ProgramInfo } from './project.js';

export interface ResolvedModelManifestEntry extends ModelManifestEntry {
  readonly codecId: string;
  readonly manifestFile: string;
  /** OpenAPI entries advertise the effective any policy used for this model. */
  readonly allowAny: boolean;
}

/** An alias of a golem-mode SDK that is no model: what an app field of it checks, and the keywords of its schema that the descriptor does not carry. */
export interface SdkAlias {
  readonly descriptor: ModelTypeDescriptor;
  readonly uncarried?: readonly string[];
}

export interface ManifestIndex {
  /** Every entry, by the module and export of its declaration. */
  readonly byProvenance: ReadonlyMap<string, ResolvedModelManifestEntry>;
  readonly files: readonly string[];
  /** Manifests advertised by loaded sources or discovered under this job's src. */
  readonly localFiles: readonly string[];
  /** The manifests of SDKs in golem mode: this job compiles their types with its own models. */
  readonly golemModeManifests: readonly { readonly file: string; readonly manifest: GolemModeManifest }[];
  /**
   * The descriptor that the manifest of a golem-mode SDK holds for a type the SDK declares. The root of a model over the type
   * (`root`) takes the SDK's descriptor, with each schema it names a reference to the SDK node; its schema equals the SDK's. A field
   * of the type is that reference (`sdkNode` names the codec of the SDK that checks and converts it), or the descriptor for a scalar alias.
   */
  sdkDescriptorForType(type: ts.Type, root: boolean): ModelTypeDescriptor | undefined;
  /** The keywords of the SDK schema of the type that its descriptors do not carry, with those of the schemas it refers to; none when the type is no SDK type or its descriptors carry them all. */
  sdkUncarriedForType(type: ts.Type): readonly string[] | undefined;
  /**
   * The alias that the type node names: its descriptor (`type Currency = string` or `type Tags = number[]`, which TypeScript resolves to the
   * plain type, so the type alone does not tell), with the limits the SDK's schema has and the SDK node of each model it names. The model of
   * the app then checks them inline, as the SDK does; `uncarried` lists the keywords of its schema that the descriptor does not carry.
   */
  sdkAliasForNode(checker: ts.TypeChecker, node: ts.TypeNode): SdkAlias | undefined;
}

/** The descriptor kinds of an SDK schema that has a node codec in the SDK's codecs file; a scalar alias has none and is written inline. */
const NODE_KINDS: ReadonlySet<string> = new Set(['object', 'array', 'tuple', 'union', 'intersection']);

/** The kind of the descriptor of the SDK schema `name`, through the schemas that only name another. */
function descriptorKind(manifest: GolemModeManifest, name: string, seen: readonly string[] = []): string {
  const text = golemModeComponents(manifest).get(name)?.descriptor;
  if (text === undefined) throw new Error(`The SDK manifest has no descriptor for the schema ${JSON.stringify(name)}. Regenerate the SDK with this golem version.`);
  const descriptor = JSON.parse(text) as { readonly kind: string; readonly id?: string; readonly name?: string };
  const next = descriptor.kind === 'generated-model' ? descriptor.id : descriptor.kind === 'reference' ? descriptor.name : undefined;
  return next === undefined || seen.includes(next) ? descriptor.kind : descriptorKind(manifest, next, [...seen, name]);
}

/**
 * The descriptor of the SDK schema `name`, with each schema it names a reference to the SDK node (`generated-model` with the codec id,
 * also `sdkNode`): the model's check is the SDK's validator and its conversion calls the node codec the SDK's codecs file exports, so no
 * SDK conversion is written twice. A scalar alias, which has no node codec, is written inline.
 */
function sdkDescriptorOf(manifest: GolemModeManifest, name: string): ModelTypeDescriptor | undefined {
  const text = golemModeComponents(manifest).get(name)?.descriptor;
  if (text === undefined) return undefined;
  const nodeReferences = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(nodeReferences);
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const named = record.kind === 'generated-model' ? record.id : record.kind === 'reference' ? record.name : undefined;
    if (typeof named !== 'string') return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, nodeReferences(item)]));
    const { kind: _kind, id: _id, name: _name, projection: _projection, ...rest } = record;
    const codecId = golemModeComponents(manifest).get(named)?.codecId;
    if (!NODE_KINDS.has(descriptorKind(manifest, named))) return { ...sdkDescriptorOf(manifest, named), ...(nodeReferences(rest) as object), sdkNode: codecId };
    if (codecId === undefined) throw new Error(`The SDK manifest names no codec for the schema ${JSON.stringify(named)}. Regenerate the SDK with this golem version.`);
    return { kind: 'generated-model', id: codecId, ...(nodeReferences(rest) as object), sdkNode: codecId };
  };
  return nodeReferences(JSON.parse(text)) as ModelTypeDescriptor;
}

/** The entry of an SDK type in a table keyed by the file and name of its declaration, found by the type's alias or its own symbol. */
function sdkEntryOfType<Entry>(table: ReadonlyMap<string, Entry>, type: ts.Type): Entry | undefined {
  for (const symbol of [type.aliasSymbol, type.getSymbol?.()]) {
    for (const declaration of symbol?.declarations ?? []) {
      const file = canonicalFilename(declaration.getSourceFile().fileName);
      const found = table.get(`${file}\0${symbol!.getName()}`) ?? table.get(`${file.replace(/\.d\.([cm]?ts)$/, '.$1')}\0${symbol!.getName()}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
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
  // A package without a record is not used; its settings are equal when their stable JSON is.
  const settings = (extensions: GolemProfile['extensions'], name: string): string => extensions?.[name] === undefined ? 'not used' : JSON.stringify(stableValue(extensions[name]));
  for (const name of [...new Set([...Object.keys(advertised.extensions ?? {}), ...Object.keys(profile.extensions ?? {})])].sort(compareText)) {
    const [manifest, project] = [settings(advertised.extensions, name), settings(profile.extensions, name)];
    if (manifest !== project) differing.push(`extensions of ${name}: manifest ${manifest}, project ${project}`);
  }
  if (differing.length > 0) {
    throw new Error(
      `Model manifest profile mismatch in ${displayPath(filename)}: ${differing.join('; ')}. The project expects `
      + `{ mobx: ${expected.mobx}, validation: ${expected.validation}, allowAny: ${expected.allowAny}, unknownFormats: ${expected.unknownFormats}${profile.extensions === undefined ? '' : `, extensions: ${JSON.stringify(stableValue(profile.extensions))}`} }. `
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
  const golemModeManifests: { file: string; manifest: GolemModeManifest }[] = [];
  // The descriptor of each SDK type of a golem-mode manifest, with the schemas it names inline, by the provenance of its declaration.
  const sdkDescriptors = new Map<string, { readonly root: ModelTypeDescriptor; readonly field: ModelTypeDescriptor }>();
  const sdkUncarried = new Map<string, readonly string[]>();
  // The descriptor of each alias of a golem-mode manifest that is no model, by the provenance of its declaration.
  const sdkAliases = new Map<string, SdkAlias>();
  for (const filename of filenames) {
    // Explicit SDK manifests stay in the load set for duplicate-id and profile
    // checks. Only manifests this job discovered or advertised are watch inputs
    // until emit records the ones it actually referenced.
    if (local.has(filename)) onInput?.(filename);
    if (!existsSync(filename)) throw new Error(`Model manifest does not exist: ${displayPath(filename)}`);
    const manifest = readModelManifest(filename);
    validateManifestProfile(manifest, filename, profile);
    const golem = isGolemModeManifest(manifest) ? manifest : undefined;
    if (golem !== undefined) {
      golemModeManifests.push({ file: filename, manifest: golem });
      for (const alias of golem.components.filter((component) => component.type !== undefined)) {
        const entry: SdkAlias = { descriptor: sdkDescriptorOf(golem, alias.name)!, ...(alias.uncarried?.length ? { uncarried: alias.uncarried } : {}) };
        for (const provenance of [alias.type!, ...(alias.type!.aliases ?? [])]) {
          sdkAliases.set(manifestProvenance(filename, provenance.module, provenance.export), entry);
        }
      }
    }
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
      // A golem-mode model has its codec id on the component named as its declared type (`validateModelManifest` checked it is there).
      const component = golem && golemModeComponents(golem).get(model.type.export);
      const codecId = component?.codecId ?? model.codecId!;
      const resolved: ResolvedModelManifestEntry = { ...model, codecId, allowAny: model.allowAny, manifestFile: filename };
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
      if (golem !== undefined && component !== undefined) {
        const descriptor = sdkDescriptorOf(golem, component.name);
        if (descriptor !== undefined) {
          const reference = NODE_KINDS.has(descriptor.kind) ? { kind: 'generated-model' as const, id: codecId, sdkNode: codecId } : { ...descriptor, sdkNode: codecId };
          for (const provenance of provenances) {
            sdkDescriptors.set(manifestProvenance(filename, provenance.module, provenance.export), { root: descriptor, field: reference });
            if (component.uncarried?.length) sdkUncarried.set(manifestProvenance(filename, provenance.module, provenance.export), component.uncarried);
          }
        }
      }
    }
  }

  return {
    byProvenance,
    files: filenames,
    localFiles,
    golemModeManifests,
    sdkDescriptorForType(type: ts.Type, root: boolean): ModelTypeDescriptor | undefined {
      const found = sdkEntryOfType(sdkDescriptors, type);
      return found === undefined ? undefined : root ? found.root : found.field;
    },
    sdkUncarriedForType: (type: ts.Type) => sdkEntryOfType(sdkUncarried, type),
    sdkAliasForNode(checker: ts.TypeChecker, node: ts.TypeNode): SdkAlias | undefined {
      if (sdkAliases.size === 0 || !ts.isTypeReferenceNode(node)) return undefined;
      const named = checker.getSymbolAtLocation(node.typeName);
      const symbol = named !== undefined && (named.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(named) : named;
      for (const declaration of symbol?.declarations ?? []) {
        const file = canonicalFilename(declaration.getSourceFile().fileName);
        const found = sdkAliases.get(`${file}\0${symbol!.getName()}`)
          ?? sdkAliases.get(`${file.replace(/\.d\.([cm]?ts)$/, '.$1')}\0${symbol!.getName()}`);
        if (found !== undefined) return found;
      }
      return undefined;
    },
  };
}
