import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import YAML from 'yaml';
import { canonicalPath, displayPath, isInsideDirectory, isRecord } from './plan-support.js';
import type { HookParticipants } from './extension-hooks.js';
import type { JobFacts, ProgramView } from './job-facts.js';

// The helpers live in plan-support, which plan entries may import; the rest of core reads them here.
export { canonicalPath, displayPath, isInsideDirectory, isRecord };

/** Canonical text order: by UTF-16 code unit, so output does not depend on the machine's locale or ICU data. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A copy of a JSON-like value with its object keys sorted at every depth. */
export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

/** Indented JSON text with sorted keys and a final line end, so equal values give equal text. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export interface GolemProfile {
  /**
   * How much a generated codec checks: `true` (default) the whole schema, `'sanity'` the shape only (types, required and extra keys,
   * enums, union tags), `false` nothing. The order is `false` < `'sanity'` < `true`.
   */
  readonly validation: boolean | 'sanity';
  readonly allowAny?: boolean;
  /** What a schema format that golem does not implement does: `error` (default) fails generation, `warn` skips its check. */
  readonly unknownFormats?: 'warn' | 'error';
  /**
   * The settings of the extensions that change generated code, by the name of the package whose block holds them. A manifest records
   * them as written and the job that reads a manifest compares them as stable JSON. A missing package, or no record at all, means "not used".
   */
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface ResolvedGolemProfile extends GolemProfile {
  readonly allowAny: boolean;
  readonly unknownFormats: 'warn' | 'error';
}

/** The validation levels from the lowest to the highest; a model or call may lower the level of its project, never raise it. */
const VALIDATION_LEVELS: readonly GolemProfile['validation'][] = [false, 'sanity', true];

export function isValidationLevel(value: unknown): value is GolemProfile['validation'] {
  return VALIDATION_LEVELS.includes(value as GolemProfile['validation']);
}

/** The error for a validation level that is none of `true`, `false` and `'sanity'`; `label` names the key that held it. */
export function invalidValidationLevelMessage(label: string): string {
  return `${label} must be true, false or "sanity".`;
}

/** 0 for `false`, 1 for `'sanity'`, 2 for `true`: a level above another has the greater rank. */
export function validationRank(level: GolemProfile['validation']): number {
  return VALIDATION_LEVELS.indexOf(level);
}

/** Programmatic callers receive the same defaults and checks as YAML users. */
export function resolveProfile(profile: GolemProfile): ResolvedGolemProfile {
  if (!isRecord(profile)) throw new TypeError('Generation profile must be an object.');
  for (const key of Object.keys(profile)) {
    if (!['validation', 'allowAny', 'unknownFormats', 'extensions'].includes(key)) {
      throw new TypeError(`Unknown generation profile option: ${key}.`);
    }
  }
  if (!isValidationLevel(profile.validation)) throw new TypeError(invalidValidationLevelMessage('Generation profile validation'));
  if (profile.allowAny !== undefined && typeof profile.allowAny !== 'boolean') {
    throw new TypeError('Generation profile allowAny must be a boolean.');
  }
  if (profile.unknownFormats !== undefined && profile.unknownFormats !== 'warn' && profile.unknownFormats !== 'error') {
    throw new TypeError('Generation profile unknownFormats must be "warn" or "error".');
  }
  const { extensions, ...rest } = profile;
  if (extensions !== undefined && (!isRecord(extensions) || !Object.values(extensions).every(isRecord))) {
    throw new TypeError('Generation profile extensions must map a package name to an object of settings.');
  }
  const resolved: ResolvedGolemProfile = {
    ...rest,
    ...(extensions === undefined || !Object.keys(extensions).length ? {} : { extensions }),
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

/**
 * The diagnostics a job or a rewrite participant returned, checked and copied: an array of objects with a severity `error` or `warning`,
 * a nonempty string `code`, a string `message`, string `file` and `path`, and `line` and `column` whole numbers from 1. `fail` makes the
 * error for a problem, which it gets as a phrase such as `an invalid diagnostic line`.
 */
export function checkedDiagnostics(value: unknown, fail: (problem: string) => Error): GolemDiagnostic[] {
  if (!Array.isArray(value)) throw fail('invalid diagnostics');
  return value.map((diagnostic: unknown): GolemDiagnostic => {
    if (!isRecord(diagnostic)
      || (diagnostic.severity !== GolemDiagnosticSeverity.Error && diagnostic.severity !== GolemDiagnosticSeverity.Warning)
      || typeof diagnostic.code !== 'string'
      || !diagnostic.code.trim()
      || typeof diagnostic.message !== 'string') {
      throw fail('an invalid diagnostic');
    }
    for (const key of ['file', 'path'] as const) {
      if (diagnostic[key] !== undefined && typeof diagnostic[key] !== 'string') throw fail(`an invalid diagnostic ${key}`);
    }
    for (const key of ['line', 'column'] as const) {
      if (diagnostic[key] !== undefined && (typeof diagnostic[key] !== 'number' || !Number.isSafeInteger(diagnostic[key]) || diagnostic[key] < 1)) {
        throw fail(`an invalid diagnostic ${key}`);
      }
    }
    const file = typeof diagnostic.file === 'string' ? diagnostic.file : undefined;
    const pathValue = typeof diagnostic.path === 'string' ? diagnostic.path : undefined;
    const line = typeof diagnostic.line === 'number' ? diagnostic.line : undefined;
    const column = typeof diagnostic.column === 'number' ? diagnostic.column : undefined;
    return {
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      ...(pathValue === undefined ? {} : { path: pathValue }),
    };
  });
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
  /**
   * A resource that every job and core's rewrite share for the run or watch session, such as the one TypeScript program session.
   * The first request under `key` creates it; it is not tied to a job, so no job's removal closes it.
   */
  share<Resource extends Disposable>(key: string, create: () => Resource): Resource;
}

/** What a job receives from the host on top of its own options: a way to report each local input it reads, and the resources it keeps across runs. */
export interface GeneratorHostContext {
  /** Call with each local file path before reading it, so golem can skip the job when its inputs are unchanged. */
  readonly onInput?: InputObserver;
  readonly session?: GeneratorSession;
  /** What the program of a job that reads the program leaves out or stubs of the jobs after it; omitted for a job that reads no program. */
  readonly programView?: ProgramView;
  /** For a job that offers hooks (`facts.hooks`): the participants of the extensions that fill each, in the order of golem.yaml. Omitted for a job that offers none. */
  readonly hooks?: HookParticipants;
}

/**
 * The generator entry of a golem package (`golem.generator`): what the module exports. `generate` receives the `options` that the package's own
 * plan entry returned for the job, plus the host context, and returns contents; the CLI owns all writes. Every artifact it returns must carry
 * the ownership marker of its package: a first line such as `/* Generated by <package>. Do not edit. *\/`, with a space, a line end or a full stop
 * after the package name, or the JSON marker.
 */
export type GolemGeneratorEntry<Options = unknown> = GolemProvider<Options & GeneratorHostContext>;

/**
 * The value of the `ModelBoundary` contract: the inputs of the app's model boundary, which core's rewrite and the jobs that read models
 * need. The one job that provides the contract owns this value.
 */
export interface ModelBoundaryValue {
  /** The models root, absolute. */
  readonly root: string;
  /** The directory of the golem.yaml. */
  readonly directory: string;
  /** The folder of the generated model files, absolute. */
  readonly output: string;
  /** The file-name endings of a model file. */
  readonly suffixes: readonly string[];
}

/**
 * The value of the `CodecsHost` contract: where the codec files of golem SDKs live. The codecs file of an SDK in the folder `sdkOutput` is
 * `sdkCodecsFile({ ...value, sdkOutput })`.
 */
export interface CodecsHostValue {
  /** The folder of the generated model files, which holds one codecs file for each golem SDK, absolute. */
  readonly modelsOutput: string;
  /** The directory of the golem.yaml. */
  readonly configDirectory: string;
}

/** The values of the contracts that jobs provide, by contract name. Core knows the two contracts below by name; a package may add others. */
export interface ContractValues {
  readonly ModelBoundary?: ModelBoundaryValue;
  readonly CodecsHost?: CodecsHostValue;
  readonly [contract: string]: unknown;
}

/** What core hands to the plan entry of a block in the first pass. */
export interface PlanContext {
  /** The golem.yaml file, absolute and canonical. */
  readonly configFile: string;
  /** The directory of the golem.yaml, which relative paths in the block are anchored to. */
  readonly directory: string;
  /** The project tsconfig that golem.yaml names, absolute. */
  readonly tsconfig: string;
  /** The shared root keys of golem.yaml, resolved. */
  readonly profile: ResolvedGolemProfile;
  /** The root key `exact`; omitted means it is not set. */
  readonly exact?: boolean;
  /** The value under the package's key in golem.yaml, as parsed. The plan entry validates all of it. */
  readonly block: unknown;
  /** Call with each local path the block reads or resolves, before touching it, so golem can skip a job whose inputs are unchanged. */
  readonly onInput?: InputObserver;
}

/** The parts of a job that the second pass may change. */
export interface JobPlanParts<Options = unknown> {
  readonly facts: JobFacts;
  /** What the generator receives as its context. Core reads none of it; it is compared as stable JSON for the job cache. */
  readonly options: Options;
}

/** One job that a plan entry declares in the first pass. */
export interface PlannedJob<Options = unknown> extends JobPlanParts<Options> {
  /** The value of each contract in `facts.provides`. It comes from the job's own block, so it is known in the first pass. */
  readonly provided?: ContractValues;
}

/** What core hands to a plan entry for one of its jobs in the second pass. */
interface PlanContracts {
  /** The value of each contract in the job's `facts.needs`, from the one job that provides it. */
  readonly needed: ContractValues;
  /** For each contract in the job's `facts.provides`: the first-pass facts of the jobs that need it. */
  readonly consumers: Readonly<Record<string, readonly JobFacts[]>>;
}

/**
 * The plan entry of a golem package (`golem.plan`): the light module, which imports no TypeScript, no generator code and no yaml, that the
 * module exports as `plan`. Core loads it with `import()` when it reads golem.yaml.
 */
export interface GolemPlanEntry<Options = unknown> {
  /** First pass: validate the whole block and declare its jobs with their facts, in the order the block lists them. */
  declare(context: PlanContext): readonly PlannedJob<Options>[];
  /** Second pass: give one job the contract values it needs, and let it change its facts and options, such as the SDK folders a codecs host reads. */
  link?(job: PlannedJob<Options>, contracts: PlanContracts): JobPlanParts<Options>;
}

/** One job of a resolved golem.yaml. */
export interface GolemJob<Options = unknown> {
  /** The same as `facts.id`: unique among the jobs of one config, and the name of the job in every message. */
  readonly id: string;
  /** The name of the package that registers the block of this job. */
  readonly package: string;
  /** The golem.yaml key that holds this job. */
  readonly block: string;
  readonly facts: JobFacts;
  readonly options: Options;
}

export interface GolemProvider<Context> {
  readonly apiVersion: 1;
  generate(context: Context): GolemResult | Promise<GolemResult>;
}

/** A YAML file that does not parse: the developer's input to fix. The message starts with `<file>:<line>:<column>`; `cause` is the parser's error. */
export class YamlFileError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'YamlFileError';
  }
}

/**
 * The parsed YAML of `text`, which came from `filename`. A parse error becomes a `YamlFileError` whose message starts with
 * the file, line and column: the path relative to the working directory for an absolute `filename`, or `filename` as written
 * for a URL. Any other failure passes through.
 */
export function parseYamlFile(text: string, filename: string, options?: YAML.DocumentOptions & YAML.ParseOptions): unknown {
  try {
    return YAML.parse(text, options);
  } catch (error) {
    if (!(error instanceof YAML.YAMLParseError)) throw error;
    const file = displayPath(filename);
    const start = error.linePos?.[0];
    // The parser's message ends its first line with the position; the prefix already says it.
    const reason = error.message.replace(/ at line \d+, column \d+:/, ':').trimEnd();
    throw new YamlFileError(`${file}${start === undefined ? '' : `:${start.line}:${start.col}`} ${reason}`, { cause: error });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The faults of golem or of a tool it runs. A system error, a `SyntaxError` from a file the user wrote and a golem error name a condition the user fixes. */
const FAULTS = [TypeError, RangeError, ReferenceError, AggregateError];

/** An error that is a fault, or has one in its `cause` chain. The `seen` set stops a chain that leads back to itself. */
function holdsFault(error: unknown, seen = new Set<unknown>()): boolean {
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  return FAULTS.some((type) => error instanceof type) || holdsFault(error.cause, seen);
}

/**
 * What the golem command prints for a failure. Golem's own errors and the conditions the user fixes (a missing or unreadable file, a file that
 * is not JSON, a command that does not exist) print as their message. A programming fault (a `TypeError`, `RangeError` or `ReferenceError`,
 * also as the `cause` of the error that wraps it) and an `AggregateError`, golem's own collection of cleanup failures whose message does not
 * name its members, print with their stack and cause chain, which the message alone would lose.
 */
export function failureText(error: unknown): string {
  return holdsFault(error) ? inspect(error) : errorMessage(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

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
  return [...found].sort(compareText);
}
