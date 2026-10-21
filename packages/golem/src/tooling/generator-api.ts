import fs from 'node:fs';
import path from 'node:path';
/** Shared API-1 contracts. Providers return contents; the CLI owns all writes. */
export {
  assertPortableFilenames,
  assertUniquePublicExports,
  bindingName,
  camelIdentifier,
  identifier,
  NameScope,
  propertyName,
  RESERVED_BINDING_NAMES,
  RESERVED_MODEL_MEMBERS,
} from './names.js';

/** Canonical text order: by UTF-16 code unit, so output does not depend on the machine's locale or ICU data. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface GolemProfile {
  readonly mobx: boolean;
  readonly validation: boolean;
  readonly allowAny?: boolean;
  /** What a schema format that golem does not implement does: `error` (default) fails generation, `warn` skips its check. */
  readonly unknownFormats?: 'warn' | 'error';
}

export interface ResolvedGolemProfile extends GolemProfile {
  readonly allowAny: boolean;
  readonly unknownFormats: 'warn' | 'error';
}

/** The error for a `models.sources` entry whose real path is outside `models.root`: the yaml and the API stop with this text. */
export function outsideModelsRootMessage(entry: string, root: string): string {
  return `RUNM1075: models.sources entry ${entry} is outside the models root ${root}. A models job generates only files inside its root.`;
}

/**
 * The real path of `filename`: each link of its existing prefix is followed, and the part that does not exist yet stays
 * as written. A file reached through a folder link has the same real path as the file itself.
 */
export function canonicalPath(filename: string): string {
  let ancestor = path.resolve(filename);
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return path.join(fs.realpathSync.native(ancestor), ...missing);
}

/** Programmatic callers receive the same defaults and checks as YAML users. */
export function resolveProfile(profile: GolemProfile): ResolvedGolemProfile {
  if (!isRecord(profile)) throw new TypeError('Generation profile must be an object.');
  for (const key of Object.keys(profile)) {
    if (!['mobx', 'validation', 'allowAny', 'unknownFormats'].includes(key)) {
      throw new TypeError(`Unknown generation profile option: ${key}.`);
    }
  }
  if (typeof profile.mobx !== 'boolean' || typeof profile.validation !== 'boolean') {
    throw new TypeError('Generation profile mobx and validation must be booleans.');
  }
  if (profile.allowAny !== undefined && typeof profile.allowAny !== 'boolean') {
    throw new TypeError('Generation profile allowAny must be a boolean.');
  }
  if (profile.unknownFormats !== undefined && profile.unknownFormats !== 'warn' && profile.unknownFormats !== 'error') {
    throw new TypeError('Generation profile unknownFormats must be "warn" or "error".');
  }
  const resolved: ResolvedGolemProfile = {
    ...profile,
    allowAny: profile.allowAny ?? false,
    unknownFormats: profile.unknownFormats ?? 'error',
  };
  return Object.freeze(resolved);
}

export interface GolemArtifact {
  readonly path: string;
  readonly content: string;
}

/** Stable diagnostic severities shared by the CLI and every generator. */
export enum GolemDiagnosticSeverity {
  Error = 'error',
  Warning = 'warning',
}

/** Provider-specific diagnostic codes remain strings so providers can evolve independently. */
export type GolemDiagnosticCode = string;

/** Typed source diagnostics returned by a provider without putting provenance in generated schemas. */
export interface GolemDiagnostic {
  readonly code: GolemDiagnosticCode;
  readonly severity: GolemDiagnosticSeverity;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly path?: string;
}

export type ControllerUriVersioningType = 'URI' | 'uri' | 0;

/** The subset of Nest URI versioning options which has a static OpenAPI meaning. */
export interface ControllerUriVersioning {
  readonly type?: ControllerUriVersioningType;
  readonly prefix?: string;
  readonly defaultVersion?: string | readonly string[];
}

/** OpenAPI root tag metadata supplied by a controller job. */
export interface ControllerTag extends Readonly<Record<string, unknown>> {
  readonly name: string;
}

export interface GolemResult {
  readonly artifacts: readonly GolemArtifact[];
  readonly manifestPaths: readonly string[];
  readonly watchInputs: readonly string[];
  readonly diagnostics?: readonly GolemDiagnostic[];
}

/** Report a local input before attempting to read or resolve it. */
export type InputObserver = (absolutePath: string) => void;

/**
 * Resources a provider keeps across the generation runs of one CLI pipeline
 * or watch session, such as a TypeScript compiler process. The session owner
 * disposes a job's resources when the job is removed or the session ends. A
 * resource with an `inputsChanged(filenames)` method is told which inputs the
 * host saw change before each run.
 */
export interface GeneratorSession {
  retain<Resource extends Disposable>(key: string, create: () => Resource): Resource;
}

export interface ModelContext {
  readonly root: string;
  /** The golem.yaml's directory, whose `.golem/` holds the codec keys; defaults to `root`. */
  readonly directory?: string;
  /** File-name endings that make a file below `root/src` a model source; defaults to `.model.ts` and `.models.ts`. */
  readonly suffixes?: readonly string[];
  readonly output?: string;
  readonly sources?: readonly string[];
  readonly profile: GolemProfile;
  /** The `golem.yaml` default for the `exact` option of a model that sets none; omitted means `true`. */
  readonly exact?: boolean;
  readonly manifestInputs?: readonly string[];
  readonly onInput?: InputObserver;
  readonly session?: GeneratorSession;
}

/**
 * Context of a `generators` job from an installed package. Every artifact the generator returns must start
 * with the ownership header for its package, such as `/* Generated by <package>. Do not edit. *\/`.
 * A space or a full stop must follow the package name.
 */
export interface GeneratorJobContext {
  /** The configuration file's directory. */
  readonly directory: string;
  /** The directory the generator owns; every artifact is written inside it. */
  readonly output: string;
  /** The entry's `options`, passed as-is; the generator validates them. */
  readonly options: unknown;
  readonly profile: GolemProfile;
  /** Call with each local file path before reading it, so golem can skip the job when its inputs are unchanged. */
  readonly onInput?: InputObserver;
}

export interface OpenApiContext {
  readonly input: string;
  readonly output: string;
  readonly name?: string;
  readonly allowRemoteRefs?: boolean;
  readonly remoteHosts?: readonly string[];
  readonly maxRefBytes?: number;
  readonly maxRefDocuments?: number;
  readonly refTimeoutMs?: number;
  /** `temporal` maps `format: date-time`, `date` and `duration` to Temporal types; the default is `date`. */
  readonly dates?: 'date' | 'temporal';
  readonly profile: GolemProfile;
  readonly onInput?: InputObserver;
}

/** Static Nest controller analysis context consumed by @exprtlabs/golem-ts-openapi. */
export interface ControllerContext {
  /** Absolute project root used for TypeScript configuration and dependency resolution. */
  readonly root: string;
  /** Exact absolute OpenAPI file to emit. */
  readonly output: string;
  /** Optional controller entrypoints; omitted means provider discovery below root/src. */
  readonly sources?: readonly string[];
  /** File-name endings that make a file below `root/src` a controller source; defaults to `.controller.ts`. */
  readonly suffixes?: readonly string[];
  /** Defaults to OpenAPI 3.2.0; 3.1.2 is the supported explicit target. */
  readonly openapiVersion?: '3.2.0' | '3.1.2';
  readonly info: Readonly<Record<string, unknown>>;
  readonly servers?: readonly Readonly<Record<string, unknown>>[];
  readonly securitySchemes?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly tags?: readonly ControllerTag[];
  readonly globalPrefix?: string;
  readonly uriVersioning?: ControllerUriVersioning;
  readonly profile: GolemProfile;
  /** The `golem.yaml` default for the `exact` option of a model that sets none; omitted means `true`. */
  readonly exact?: boolean;
  /**
   * The models job of the same golem.yaml, absent when it has none. A controller type that is a shared model of the app, or a
   * class that extends the generated base of one, is matched to its model through the file this job writes for it.
   */
  readonly models?: ControllerModels;
  readonly onInput?: InputObserver;
  readonly session?: GeneratorSession;
}

/** What the controllers analysis needs to know of the models job: the inputs of its model boundary. */
export interface ControllerModels {
  /** `models.root`, absolute. */
  readonly root: string;
  /** The directory of the golem.yaml. */
  readonly directory: string;
  /** `models.output`, absolute. */
  readonly output: string;
  /** The file-name endings of a model file; omitted means the golem default. */
  readonly suffixes?: readonly string[];
}

export interface GolemProvider<Context> {
  readonly apiVersion: 1;
  generate(context: Context): GolemResult | Promise<GolemResult>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export const DEFAULT_MODEL_SUFFIXES: readonly string[] = ['.model.ts', '.models.ts'];
export const DEFAULT_CONTROLLER_SUFFIXES: readonly string[] = ['.controller.ts'];

/** Matches a source file name that ends in one of `suffixes` and is not a generated companion (`*.generated.ts`, `.mts`, `.cts`). */
export function suffixPattern(suffixes: readonly string[]): RegExp {
  const endings = suffixes.map(suffix => suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(?![\\s\\S]*\\.generated\\.[cm]?ts$)[\\s\\S]*(?:${endings})$`);
}

/** The file name without the longest of `suffixes` it ends in, or without its extension when it ends in none. */
export function stripSourceSuffix(filename: string, suffixes: readonly string[]): string {
  const matched = suffixes.filter(suffix => filename.endsWith(suffix)).sort((left, right) => right.length - left.length)[0];
  return matched === undefined ? filename.replace(/\.[cm]?ts$/, '') : filename.slice(0, -matched.length);
}

export interface SourceDiscoveryOptions {
  /** Matches a source filename. */
  readonly source: RegExp;
  /** Identity applied to each reported path; defaults to `path.normalize`. */
  readonly normalize?: (filename: string) => string;
  /** Observes the root (even when missing), each directory read and each source. */
  readonly onInput?: (filename: string) => void;
  /** Directories that are not searched, such as generated output roots. */
  readonly skip?: (directory: string) => boolean;
}

/**
 * Sorted, unique sources beneath `root`. Dot entries and node_modules are not
 * searched; a missing root yields no sources.
 */
export function discoverSources(root: string, options: SourceDiscoveryOptions): string[] {
  const normalize = options.normalize ?? path.normalize;
  const found = new Set<string>();
  options.onInput?.(normalize(root));
  const visit = (directory: string): void => {
    if (options.skip?.(directory)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return;
      throw error;
    }
    if (directory !== root) options.onInput?.(normalize(directory));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (options.source.test(entry.name)) {
        const normalized = normalize(filename);
        options.onInput?.(normalized);
        found.add(normalized);
      }
    }
  };
  visit(root);
  return [...found].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}
