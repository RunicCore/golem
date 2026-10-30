import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
import { MISSING, fileSignature } from '../input-watcher.js';
import type { CodecSchemaClosureEntry } from '../validation-plan.js';
import { canonicalFilename, effectiveConfigPath, isUnderOutputs } from './project.js';
import type { ProgramInfo } from './project.js';

export interface ResolvedModelManifestEntry extends ModelManifestEntry {
  readonly manifestFile: string;
  /** OpenAPI entries advertise the effective any policy used for this model. */
  readonly allowAny: boolean;
}

/** An entry that names a generated model class, with the file of its module: the only kind that a model of this project can use. */
export interface GeneratedModelManifestEntry extends ResolvedModelManifestEntry {
  readonly generated: NonNullable<ModelManifestEntry['generated']>;
  readonly generatedFile: string;
}

export interface ManifestIndex {
  /** The entries that name a generated class. An entry without one is an SDK type, which a model of this project sees as a plain type. */
  readonly byId: ReadonlyMap<string, GeneratedModelManifestEntry>;
  readonly byProvenance: ReadonlyMap<string, GeneratedModelManifestEntry>;
  readonly files: readonly string[];
  /** Manifests advertised by loaded sources or discovered under this job's src. */
  readonly localFiles: readonly string[];
  readonly validationSchemaClosure: readonly CodecSchemaClosureEntry[];
  /** The manifests of SDKs in golem mode: this job compiles their types with its own models. */
  readonly golemModeManifests: readonly { readonly file: string; readonly manifest: GolemModeManifest }[];
  /** Runtime (value) exports of the generated module an entry names. */
  runtimeExports(model: GeneratedModelManifestEntry): ReadonlySet<string>;
  externalModelForType(type: ts.Type): GeneratedModelManifestEntry | undefined;
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

function isRuntimeExport(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  return (resolved.flags & ts.SymbolFlags.Value) !== 0;
}

/**
 * A validation that passed: the request it answered, the signature of each file it depended on, and the exports it found. A failed
 * validation leaves none, so a failure is never taken for a pass.
 */
interface ValidatedModules {
  readonly request: string;
  /** Every path the program reported, which the job's observer hears again when the program is not opened. */
  readonly reported: readonly string[];
  /** The signature, as it was before the program read the file, of each manifest, each source file of the program except the default library, each probe that found nothing and each package.json. */
  readonly signatures: ReadonlyMap<string, string>;
  readonly exportsById: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The last passed validation of each compiler session, which a watch keeps across its cycles. A session that closes takes its record with it. */
const lastValidated = new WeakMap<object, ValidatedModules>();

function validateGeneratedModules(
  info: ProgramInfo,
  root: string,
  models: readonly GeneratedModelManifestEntry[],
  onInput?: InputObserver,
): ReadonlyMap<string, ReadonlySet<string>> {
  const { options } = info;
  const exportsById = new Map<string, ReadonlySet<string>>();
  // A manifest of SDK types alone names no module to validate.
  if (models.length === 0) return exportsById;
  const files = new Map<GeneratedModelManifestEntry, string>();
  const resolutionCache = new Map<string, string>();
  for (const model of models) {
    const moduleName = model.generated.module;
    const cacheKey = `${dirname(model.manifestFile)}\0${moduleName}`;
    let resolvedFileName = resolutionCache.get(cacheKey);
    if (!resolvedFileName) {
      const resolved = info.program.session.resolveModuleName(moduleName, model.manifestFile, options).resolvedModule;
      if (!resolved) {
        throw new Error(
          `Model manifest ${displayPath(model.manifestFile)} references missing generated module `
          + `${moduleName} for ${model.id}.`,
        );
      }
      resolvedFileName = canonicalFilename(resolved.resolvedFileName);
      resolutionCache.set(cacheKey, resolvedFileName);
    }
    onInput?.(resolvedFileName);
    files.set(model, resolvedFileName);
  }
  // All exports in this generation job share one program and type checker.
  // A manifest with many entries must not reparse its dependency graph once
  // for every model, whether entries share a module or use narrow modules.
  // These modules can come from several SDK output directories. The generic
  // createProgram adapter roots its project at the first source file, which
  // can leave modules from the other SDKs outside the selected TS7 project.
  // Opening files does not make sources excluded by the app tsconfig project
  // roots, so give the one project an overlay config that explicitly lists all
  // resolved modules while extending the job's effective config to preserve its
  // options: the referenced project of a solution tsconfig, not the solution.
  const sources = [...new Set(files.values())];
  const appConfig = effectiveConfigPath(info);
  // The program is opened only when something it validates changed since the last pass: the request (the entries, the modules they
  // resolve to, the compiler options), a manifest, or a source file of the last program, which the openapi job can rewrite between two cycles.
  const request = JSON.stringify([root, appConfig, sources, models.map((model) => [model.id, model.manifestFile, model.generated.export])])
    + JSON.stringify(options, (key, value: unknown) => (key === 'configFile' ? undefined : value));
  const manifestSignatures = new Map(models.map((model) => [model.manifestFile, fileSignature(model.manifestFile)]));
  const previous = lastValidated.get(info.program.session);
  lastValidated.delete(info.program.session);
  if (previous?.request === request && [...previous.signatures].every(([filename, signature]) => fileSignature(filename) === signature)) {
    previous.reported.forEach((filename) => onInput?.(filename));
    lastValidated.set(info.program.session, previous);
    return previous.exportsById;
  }
  // A path reported again, as a session does for every file it has read, keeps the signature of its first report.
  const reported = new Map<string, string>();
  const observe: InputObserver = (filename) => {
    if (!reported.has(filename)) reported.set(filename, fileSignature(filename));
    onInput?.(filename);
  };
  const configFile = join(root, '.golem-manifest-validation.json');
  const validationConfig = appConfig
    ? { extends: appConfig, files: sources, include: [] }
    : {
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        skipLibCheck: true,
        noEmit: true,
      },
      files: sources,
      include: [],
    };
  using moduleProgram = info.program.session.openProgram({
    root,
    configFile,
    sources,
    overlays: new Map([[canonicalFilename(configFile), JSON.stringify(validationConfig)]]),
    onInput: observe,
  });
  const checker = moduleProgram.getTypeChecker();
  const runtimeExports = new Map<string, ReadonlySet<string>>();
  for (const [model, filename] of files) {
    const generated = model.generated;
    if (!generated) continue;
    let exports = runtimeExports.get(filename);
    if (!exports) {
      const sourceFile = moduleProgram.getSourceFile(filename);
      const moduleSymbol = sourceFile ? checker.getSymbolAtLocation(sourceFile) : undefined;
      exports = new Set(moduleSymbol
        ? checker.getExportsOfModule(moduleSymbol).filter(symbol => isRuntimeExport(symbol, checker)).map(symbol => symbol.name)
        : []);
      runtimeExports.set(filename, exports);
    }
    if (!exports.has(generated.export)) {
      throw new Error(
        `Model manifest ${displayPath(model.manifestFile)} references missing runtime export `
        + `${generated.export} from ${generated.module} for ${model.id}.`,
      );
    }
    exportsById.set(model.id, exports);
  }
  const signatures = new Map(manifestSignatures);
  for (const file of moduleProgram.getSourceFiles()) {
    if (moduleProgram.isSourceFileDefaultLibrary(file)) continue;
    const filename = canonicalFilename(file.fileName);
    signatures.set(filename, reported.get(filename) ?? fileSignature(filename));
  }
  // A file the program probed and did not find (a new file can shadow what it resolved to) and each package.json (its "type", "exports" and
  // "types" decide resolution) are dependencies too. The other reported paths are not: a session replays everything it ever read.
  for (const [filename, signature] of reported) {
    if (signature === MISSING || basename(filename) === 'package.json') signatures.set(filename, signature);
  }
  lastValidated.set(info.program.session, { request, reported: [...reported.keys()], signatures, exportsById });
  return exportsById;
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
  byProvenance: ReadonlyMap<string, GeneratedModelManifestEntry>,
  symbol: ts.Symbol,
): GeneratedModelManifestEntry | undefined {
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
  const byProvenance = new Map<string, GeneratedModelManifestEntry>();
  const byId = new Map<string, GeneratedModelManifestEntry>();
  // Every id of every manifest, an SDK type's included, so that two manifests cannot share one.
  const manifestOfId = new Map<string, string>();
  const validationSchemaClosure: CodecSchemaClosureEntry[] = [];
  const golemModeManifests: { file: string; manifest: GolemModeManifest }[] = [];
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
      // An entry that names no generated class is an SDK type: a model of this project sees its declaration as a plain type.
      if (!model.generated) continue;
      const resolved: GeneratedModelManifestEntry = {
        ...model,
        allowAny: model.allowAny as boolean,
        manifestFile: filename,
        generated: model.generated,
        generatedFile: canonicalFilename(
          isAbsolute(model.generated.module)
            ? model.generated.module
            : resolve(dirname(filename), model.generated.module),
        ),
      };
      byId.set(model.id, resolved);
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
    }
  }
  const exportsById = validateGeneratedModules(info, root, [...byId.values()], onInput);

  return {
    byId,
    byProvenance,
    files: filenames,
    localFiles,
    validationSchemaClosure,
    golemModeManifests,
    runtimeExports: (model) => exportsById.get(model.id) ?? new Set(),
    externalModelForType(type: ts.Type): GeneratedModelManifestEntry | undefined {
      for (const symbol of [type.aliasSymbol, type.getSymbol?.()]) {
        const model = symbol && manifestModelOfSymbol(byProvenance, symbol);
        if (model) return model;
      }
      return undefined;
    },
  };
}
