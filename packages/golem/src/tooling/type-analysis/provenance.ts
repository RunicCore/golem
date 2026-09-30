import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as ts from '../typescript-ns.js';
import {
  MODEL_MANIFEST_MARKER,
  discoverModelManifests,
  readModelManifest,
} from '../model-manifest.js';
import type {
  ModelManifest,
  ModelManifestEntry,
} from '../model-manifest.js';
import type { CodegenProfile, InputObserver } from '../generator-api.js';
import type { CodecSchemaClosureEntry } from '../ajv-tooling.js';
import { canonicalFilename } from './project.js';

export interface ResolvedModelManifestEntry extends ModelManifestEntry {
  readonly manifestFile: string;
  readonly generatedFile: string;
  /** OpenAPI entries advertise the effective any policy used for this model. */
  readonly allowAny: boolean;
}

export interface ManifestIndex {
  readonly byId: ReadonlyMap<string, ResolvedModelManifestEntry>;
  readonly byProvenance: ReadonlyMap<string, ResolvedModelManifestEntry>;
  readonly files: readonly string[];
  /** Manifests advertised by loaded sources or discovered under this job's src. */
  readonly localFiles: readonly string[];
  readonly validationSchemaClosure: readonly CodecSchemaClosureEntry[];
  /** Runtime (value) exports of the generated module an entry names. */
  runtimeExports(model: ResolvedModelManifestEntry): ReadonlySet<string>;
  externalModelForType(type: ts.Type): ResolvedModelManifestEntry | undefined;
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
  profile: CodegenProfile,
): void {
  const advertised = manifest.profile;
  if (
    !advertised
    || advertised.mobx !== profile.mobx
    || advertised.validation !== profile.validation
    || advertised.ajvStandalone !== (profile.ajvStandalone ?? false)
    || advertised.allowAny !== (profile.allowAny ?? false)
  ) {
    throw new Error(
      `Model manifest profile mismatch in ${filename}: expected `
      + `{ mobx: ${profile.mobx}, validation: ${profile.validation}, ajvStandalone: ${profile.ajvStandalone ?? false}, allowAny: ${profile.allowAny ?? false} }. `
      + 'Regenerate the SDK manifest with the same profile before model generation.',
    );
  }
}

function isRuntimeExport(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  return (resolved.flags & ts.SymbolFlags.Value) !== 0;
}

function validateGeneratedModules(
  session: ts.ProgramSession,
  root: string,
  models: readonly ResolvedModelManifestEntry[],
  options: ts.CompilerOptions,
  onInput?: InputObserver,
): ReadonlyMap<string, ReadonlySet<string>> {
  const exportsById = new Map<string, ReadonlySet<string>>();
  if (models.length === 0) return exportsById;
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (candidate): string | undefined => {
    onInput?.(canonicalFilename(candidate));
    return readFile(candidate);
  };
  host.fileExists = (candidate): boolean => {
    onInput?.(canonicalFilename(candidate));
    return fileExists(candidate);
  };
  const files = new Map<ResolvedModelManifestEntry, string>();
  const resolutionCache = new Map<string, string>();
  for (const model of models) {
    const moduleName = model.generated.module;
    const cacheKey = `${dirname(model.manifestFile)}\0${moduleName}`;
    let resolvedFileName = resolutionCache.get(cacheKey);
    if (!resolvedFileName) {
      const resolved = ts.resolveModuleName(moduleName, model.manifestFile, options, {
        fileExists: host.fileExists,
        readFile: host.readFile,
      }).resolvedModule;
      if (!resolved) {
        throw new Error(
          `Model manifest ${model.manifestFile} references missing generated module `
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
  // resolved modules while extending the app config to preserve its options.
  const sources = [...new Set(files.values())];
  const appConfig = ts.findConfigFile(root, (filename) => {
    onInput?.(canonicalFilename(filename));
    return ts.sys.fileExists(filename);
  }, 'tsconfig.json');
  const configFile = join(root, '.runic-codegen-manifest-validation.json');
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
  using moduleProgram = session.openProgram({
    root,
    configFile,
    sources,
    overlays: new Map([[canonicalFilename(configFile), JSON.stringify(validationConfig)]]),
    onInput,
  });
  const checker = moduleProgram.getTypeChecker();
  const runtimeExports = new Map<string, ReadonlySet<string>>();
  for (const [model, filename] of files) {
    let exports = runtimeExports.get(filename);
    if (!exports) {
      const sourceFile = moduleProgram.getSourceFile(filename);
      const moduleSymbol = sourceFile ? checker.getSymbolAtLocation(sourceFile) : undefined;
      exports = new Set(moduleSymbol
        ? checker.getExportsOfModule(moduleSymbol).filter(symbol => isRuntimeExport(symbol, checker)).map(symbol => symbol.name)
        : []);
      runtimeExports.set(filename, exports);
    }
    if (!exports.has(model.generated.export)) {
      throw new Error(
        `Model manifest ${model.manifestFile} references missing runtime export `
        + `${model.generated.export} from ${model.generated.module} for ${model.id}.`,
      );
    }
    exportsById.set(model.id, exports);
  }
  return exportsById;
}

export function loadModelManifests(
  root: string,
  program: ts.Program,
  options: ts.CompilerOptions,
  explicit: readonly string[],
  profile: CodegenProfile,
  onInput?: InputObserver,
): ManifestIndex {
  const advertised = new Set<string>();
  const markerPattern = new RegExp(`${escapeRegExp(MODEL_MANIFEST_MARKER)}\\s+([^\\s*]+)`);
  for (const sourceFile of program.getSourceFiles()) {
    const marker = sourceFile.text.match(markerPattern);
    if (!marker) continue;
    const filename = canonicalFilename(resolve(dirname(sourceFile.fileName), marker[1]));
    onInput?.(filename);
    if (!existsSync(filename)) {
      throw new Error(
        `${sourceFile.fileName}: generated types advertise a missing model manifest: ${filename}`,
      );
    }
    advertised.add(filename);
  }
  const discovered = discoverModelManifests(root, onInput).map(canonicalFilename);
  discovered.forEach((filename) => onInput?.(filename));
  const localFiles = [...new Set([...discovered, ...advertised])].sort();
  const local = new Set(localFiles);
  const filenames = [...new Set([
    ...localFiles,
    ...explicit.map(canonicalFilename),
  ])].sort();
  const byProvenance = new Map<string, ResolvedModelManifestEntry>();
  const byId = new Map<string, ResolvedModelManifestEntry>();
  const validationSchemaClosure: CodecSchemaClosureEntry[] = [];
  for (const filename of filenames) {
    // Explicit SDK manifests stay in the load set for duplicate-id and profile
    // checks. Only manifests this job discovered or advertised are watch inputs
    // until emit records the ones it actually referenced.
    if (local.has(filename)) onInput?.(filename);
    if (!existsSync(filename)) throw new Error(`Model manifest does not exist: ${filename}`);
    const manifest = readModelManifest(filename);
    validateManifestProfile(manifest, filename, profile);
    validationSchemaClosure.push(...manifest.validationSchemaClosure ?? []);
    for (const model of manifest.models) {
      const existingId = byId.get(model.id);
      if (existingId) {
        throw new Error(
          `Duplicate model manifest id "${model.id}" in ${existingId.manifestFile} and ${filename}.`,
        );
      }
      if (typeof model.allowAny !== 'boolean') {
        throw new Error(
          `Invalid model manifest ${filename}: model ${model.id} must advertise an effective allowAny boolean.`,
        );
      }
      const resolved: ResolvedModelManifestEntry = {
        ...model,
        allowAny: model.allowAny as boolean,
        manifestFile: filename,
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
  const exportsById = validateGeneratedModules(program.session, root, [...byId.values()], options, onInput);

  return {
    byId,
    byProvenance,
    files: filenames,
    localFiles,
    validationSchemaClosure,
    runtimeExports: (model) => exportsById.get(model.id) ?? new Set(),
    externalModelForType(type: ts.Type): ResolvedModelManifestEntry | undefined {
      const symbols = [type.aliasSymbol, type.getSymbol?.()].filter(
        (symbol): symbol is ts.Symbol => symbol !== undefined,
      );
      for (const symbol of symbols) {
        for (const declaration of symbol.declarations ?? []) {
          const key = `${canonicalFilename(declaration.getSourceFile().fileName)}\0${symbol.getName()}`;
          const model = byProvenance.get(key);
          if (model) return model;
        }
      }
      return undefined;
    },
  };
}
