import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { jobTsconfigDiagnostics, modelsRootOf, resolveConfig, validateConfigInputs } from './config.js';
import type { GolemConfig, GolemJob } from './config.js';
import { codecKeysPath } from './generated-paths.js';
import { loadInventory, applyJob, removeRetiredJobs } from './outputs.js';
import type { FileChanges, Inventory, OutputFiles } from './outputs.js';
import { absoluteRecordPath, codeDigest, golemCode, insideAny, inventoryPaths, JobInputs, jobIsCurrent, loadJobRecords, recordPath, sameSetup, saveJobRecords } from './job-cache.js';
import type { JobRecord } from './job-cache.js';
import { DEFAULT_CONTROLLER_SUFFIXES, DEFAULT_MODEL_SUFFIXES, GolemDiagnosticSeverity, errorMessage, hasErrorCode, isInsideDirectory, isRecord, suffixPattern } from './generator-api.js';
import { distTagForVersion } from './dist-tag.js';
import { validateModelManifest } from './model-manifest.js';
import type { GolemArtifact, GolemDiagnostic, GolemResult, GeneratorSession } from './generator-api.js';
import { assertRuntimeCompatible } from './runtime-compatibility.js';
import { selectedTypeScript } from './typescript-selection.js';
import { TypeScriptNotInstalledError } from './typescript-version.js';

export type InputKind = 'config' | 'controllers' | 'openapi' | 'models' | 'generator';

const INPUT_KIND_PRIORITY: Readonly<Record<InputKind, number>> = {
  generator: 0,
  models: 1,
  openapi: 2,
  controllers: 3,
  config: 4,
};

/** Preserve the strongest dependency when one file is read by several jobs. */
export function strongestInputKind(existing: InputKind | undefined, candidate: InputKind): InputKind {
  return existing === undefined || INPUT_KIND_PRIORITY[candidate] > INPUT_KIND_PRIORITY[existing]
    ? candidate
    : existing;
}
interface LoadedProvider { readonly apiVersion: 1; generate(context: unknown): unknown }
/** What one job did in a run that executed it. */
export interface JobReport extends FileChanges {
  /** How long the job took, in milliseconds. */
  readonly ms: number;
}
export interface PipelineState {
  readonly config: GolemConfig;
  readonly results: ReadonlyMap<string, GolemResult>;
  readonly inputs: ReadonlyMap<string, InputKind>;
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly owned: ReadonlySet<string>;
  /** The ids of the jobs that executed in this run; a job reused from `previous` or skipped by the job cache is not in it. */
  readonly ran: ReadonlySet<string>;
  /** For each job in `ran`: the files it wrote or removed and its time. */
  readonly reports: ReadonlyMap<string, JobReport>;
  /** The files removed because the job that generated them is no longer configured. */
  readonly retired: readonly string[];
  /** The outputs of the jobs the job cache skipped, which have no result: the edges that tell a later watch run which jobs consume them. */
  readonly skippedOutputs: ReadonlyMap<string, readonly string[]>;
}
export interface PipelineOptions {
  readonly check?: boolean;
  readonly modelOnly?: boolean;
  readonly changedInputs?: readonly string[];
  readonly previous?: PipelineState;
  readonly onInput?: (filename: string, kind: InputKind) => void;
  readonly onConfig?: (config: GolemConfig) => void;
  readonly onOwned?: (filenames: readonly string[]) => void;
  /** Directories a job's directory inputs leave out: the compiler output of the project that builds after the run, which is no input of any job. */
  readonly ignoredDirectories?: readonly string[];
  /** Provider resources kept across runs; a run without one disposes its own. */
  readonly session?: GeneratorSessionResources;
  /** The calls that write and delete outputs; internal, for tests that fault them. */
  readonly files?: OutputFiles;
}

/** A retained resource may observe host-detected input changes. */
type SessionResource = Disposable & { inputsChanged?(filenames: readonly string[]): void };

function disposeAll(resources: Iterable<Disposable>): void {
  const errors: unknown[] = [];
  for (const resource of resources) {
    try { resource[Symbol.dispose](); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Closing generator session resources failed.');
}

/** Owns provider resources, per job, for one pipeline run or watch session. */
export class GeneratorSessionResources implements Disposable {
  private readonly jobs = new Map<string, Map<string, SessionResource>>();

  /** The session a job's provider sees; `used` collects the keys it retains in this run. */
  forJob(jobId: string, used: Set<string>): GeneratorSession {
    return {
      retain: <Resource extends Disposable>(key: string, create: () => Resource): Resource => {
        let resources = this.jobs.get(jobId);
        if (!resources) this.jobs.set(jobId, resources = new Map());
        let resource = resources.get(key);
        if (!resource) resources.set(key, resource = create());
        used.add(key);
        return resource as Resource;
      },
    };
  }

  /** Forward inputs the host saw change to every resource that observes them. */
  inputsChanged(filenames: readonly string[]): void {
    for (const resources of this.jobs.values()) {
      for (const resource of resources.values()) resource.inputsChanged?.(filenames);
    }
  }

  /**
   * After a successful run, close the resources of jobs that no longer exist
   * and those a rerun job stopped using. Reused jobs keep theirs.
   */
  retainUsed(jobIds: ReadonlySet<string>, used: ReadonlyMap<string, ReadonlySet<string>>): void {
    const obsolete: Disposable[] = [];
    for (const [jobId, resources] of this.jobs) {
      const keys = used.get(jobId);
      for (const [key, resource] of resources) {
        if (jobIds.has(jobId) && (!keys || keys.has(key))) continue;
        obsolete.push(resource);
        resources.delete(key);
      }
      if (resources.size === 0) this.jobs.delete(jobId);
    }
    disposeAll(obsolete);
  }

  [Symbol.dispose](): void {
    const resources: Disposable[] = [...this.jobs.values()].flatMap((job) => [...job.values()]);
    this.jobs.clear();
    disposeAll(resources);
  }
}

function golemVersion(): string {
  // dist/tooling/pipeline.js → package.json of @exprtlabs/golem.
  const manifest: unknown = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (!isRecord(manifest) || typeof manifest.version !== 'string') throw new Error('@exprtlabs/golem package.json has no version.');
  return manifest.version;
}

/** The directory and manifest of the package that owns `filename`, found by walking up to its package.json. */
function owningPackage(specifier: string, filename: string): { readonly directory: string; readonly manifest: Record<string, unknown> } {
  for (let directory = path.dirname(filename); ; directory = path.dirname(directory)) {
    const manifestFile = path.join(directory, 'package.json');
    if (fs.existsSync(manifestFile)) {
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (isRecord(manifest) && manifest.name === specifier) return { directory, manifest };
    }
    if (path.dirname(directory) === directory) throw new Error(`Cannot find the package.json of ${specifier}.`);
  }
}

/** Version of the package that owns `filename`. */
function packageVersion(specifier: string, filename: string): string {
  const { manifest } = owningPackage(specifier, filename);
  if (typeof manifest.version !== 'string') throw new Error(`${specifier} package.json has no version.`);
  return manifest.version;
}

/** The digest of the code of the package that provides a job, or undefined when it cannot be resolved. */
function providerCode(config: GolemConfig, job: GolemJob): string | undefined {
  let directory: string;
  try {
    directory = owningPackage(job.package, createRequire(path.join(config.directory, 'package.json')).resolve(`${job.package}/generator`)).directory;
  } catch {
    return undefined;
  }
  return codeDigest(directory);
}

/** The providers of the configured jobs, or of the jobs named by `only`. */
export async function providersFor(config: GolemConfig, only?: ReadonlySet<string>): Promise<ReadonlyMap<string, LoadedProvider>> {
  const requireFromProject = createRequire(path.join(config.directory, 'package.json'));
  const providers = new Map<string, LoadedProvider>();
  for (const job of config.jobs) {
    if (providers.has(job.package) || (only && !only.has(job.id))) continue;
    let filename: string;
    try { filename = requireFromProject.resolve(`${job.package}/generator`); }
    catch (error) {
      if (hasErrorCode(error, 'MODULE_NOT_FOUND')) throw new Error(`${job.kind} is configured but ${job.package} is not installed in ${config.directory}. Install it with npm install -D ${job.package}@${distTagForVersion(golemVersion())}.`);
      throw new Error(`Cannot resolve ${job.package}/generator: ${errorMessage(error)}`);
    }
    // golem publishes its own packages in lockstep; a third-party generator versions on its own.
    if (job.kind !== 'generator') assertRuntimeCompatible({ name: '@exprtlabs/golem', version: golemVersion() }, { name: job.package, version: packageVersion(job.package, filename) });
    const imported: unknown = await import(pathToFileURL(filename).href);
    if (!isRecord(imported) || imported.apiVersion !== 1 || typeof imported.generate !== 'function') {
      throw new Error(`Incompatible generator ${job.package}: CLI supports API 1; installed provider reports ${isRecord(imported) ? String(imported.apiVersion) : 'unknown'}.`);
    }
    const generate = imported.generate;
    providers.set(job.package, { apiVersion: 1, generate: (context: unknown): unknown => generate(context) });
  }
  return providers;
}

function validateResult(result: unknown, job: GolemJob): GolemResult {
  if (!isRecord(result) || !Array.isArray(result.artifacts) || !Array.isArray(result.manifestPaths) || !Array.isArray(result.watchInputs)) {
    throw new Error(`Invalid generator result from ${job.package}. Expected artifacts, manifestPaths and watchInputs.`);
  }
  // OpenAPI's historical provider result carries apiVersion.  Controller
  // providers are governed by the module-level API-1 export and may omit the
  // redundant result field; an explicit incompatible value remains invalid.
  if (job.kind === 'openapi' && result.apiVersion !== 1) {
    throw new Error(`Invalid generator result from ${job.package}: expected API 1.`);
  }
  if (job.kind === 'controllers' && result.apiVersion !== undefined && result.apiVersion !== 1) {
    throw new Error(`Invalid generator result from ${job.package}: expected API 1.`);
  }
  const artifacts = result.artifacts.map((artifact: unknown): GolemArtifact => {
    if (!isRecord(artifact) || typeof artifact.path !== 'string' || !path.isAbsolute(artifact.path) || typeof artifact.content !== 'string') throw new Error(`${job.package} returned an invalid artifact.`);
    return { path: path.normalize(artifact.path), content: artifact.content };
  });
  const paths = (values: readonly unknown[]): string[] => values.map(filename => {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error(`${job.package} returned a non-absolute input or manifest path.`);
    return path.normalize(filename);
  });
  const manifestPaths = paths(result.manifestPaths);
  for (const filename of manifestPaths) {
    const artifact = artifacts.find(artifact => artifact.path === filename);
    if (!artifact) throw new Error(`${job.package} returned a manifest without an artifact: ${filename}`);
    const manifest = validateModelManifest(JSON.parse(artifact.content) as unknown, filename);
    if (Object.entries(job.options.profile).some(([key, value]) => Reflect.get(manifest.profile, key) !== value)) {
      throw new Error(`${job.package} returned a manifest with a different generation profile. Regenerate with a compatible provider.`);
    }
  }
  const diagnostics = result.diagnostics === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(result.diagnostics)) throw new Error(`${job.package} returned invalid diagnostics.`);
      return result.diagnostics.map((diagnostic: unknown): GolemDiagnostic => {
        if (!isRecord(diagnostic)
            || (diagnostic.severity !== GolemDiagnosticSeverity.Error && diagnostic.severity !== GolemDiagnosticSeverity.Warning)
          || typeof diagnostic.code !== 'string'
          || !diagnostic.code.trim()
          || typeof diagnostic.message !== 'string') {
          throw new Error(`${job.package} returned an invalid diagnostic.`);
        }
        for (const key of ['file', 'path'] as const) {
          if (diagnostic[key] !== undefined && typeof diagnostic[key] !== 'string') {
            throw new Error(`${job.package} returned an invalid diagnostic ${key}.`);
          }
        }
        for (const key of ['line', 'column'] as const) {
          if (diagnostic[key] !== undefined
            && (typeof diagnostic[key] !== 'number' || !Number.isSafeInteger(diagnostic[key]) || diagnostic[key] < 1)) {
            throw new Error(`${job.package} returned an invalid diagnostic ${key}.`);
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
    })();
  return {
    artifacts,
    manifestPaths,
    watchInputs: paths(result.watchInputs),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function diagnosticLocation(diagnostic: GolemDiagnostic): string {
  if (!diagnostic.file) return '';
  const line = diagnostic.line === undefined ? '' : `:${diagnostic.line}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}`;
  return ` (${diagnostic.file}${line})`;
}

function writeWarnings(diagnostics: readonly GolemDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === GolemDiagnosticSeverity.Warning) process.stderr.write(`${diagnostic.code}${diagnosticLocation(diagnostic)}: ${diagnostic.message}\n`);
  }
}

function errorDiagnosticsMessage(source: string, errors: readonly GolemDiagnostic[]): string {
  return [
    `${source} reported ${errors.length} error diagnostic${errors.length === 1 ? '' : 's'}:`,
    ...errors.map(diagnostic => `  ${diagnostic.code}${diagnosticLocation(diagnostic)}: ${diagnostic.message}`),
  ].join('\n');
}

function assertNoDiagnosticErrors(job: GolemJob, result: GolemResult): void {
  const errors = result.diagnostics?.filter(diagnostic => diagnostic.severity === GolemDiagnosticSeverity.Error) ?? [];
  if (errors.length === 0) return;
  throw new Error(errorDiagnosticsMessage(job.package, errors));
}

interface RewriteRoot {
  /** The job whose compiler the scan borrows; none for a config without a models or controllers job. */
  readonly job?: GolemJob;
  /** The root the borrowed compiler is kept under: its job's root, or the config directory without a job. */
  readonly root: string;
  /** The roots of the controllers jobs whose generated operation codecs hold the project's `@Body()` and `@Query()` ids. */
  readonly controllerRoots: readonly string[];
}

/**
 * The project whose sources `golem check` scans: the tsconfig the golem.yaml names (`golem build` starts from the same
 * yaml). The scan borrows the compiler of the first models job, else of the first controllers job; a config with neither
 * opens its own, so an app that only calls an SDK is checked too. A yaml with no tsconfig file has no project.
 */
function rewriteRoot(config: GolemConfig): RewriteRoot {
  const job = config.jobs.find((candidate): candidate is Extract<GolemJob, { kind: 'models' }> => candidate.kind === 'models')
    ?? config.jobs.find((candidate): candidate is Extract<GolemJob, { kind: 'controllers' }> => candidate.kind === 'controllers');
  return {
    ...(job ? { job, root: job.options.root } : { root: config.directory }),
    controllerRoots: config.jobs.flatMap(candidate => candidate.kind === 'controllers' ? [candidate.options.root] : []),
  };
}

/**
 * The rewrite scan needs TypeScript, so its module (and the compiler seam behind it) loads only when a scan runs. A config with
 * a models or controllers job has a compiler by construction. One without scans only when TypeScript is installed: an
 * OpenAPI-only project need not have it, and without TypeScript it has no sources to scan. A TypeScript
 * that is installed but unsupported still fails here.
 */
async function loadRewriteScan(hasCompilerJob: boolean): Promise<typeof import('./rewrite-scan.js') | undefined> {
  if (!hasCompilerJob) {
    try {
      selectedTypeScript();
    } catch (error) {
      if (error instanceof TypeScriptNotInstalledError) return undefined;
      throw error;
    }
  }
  return import('./rewrite-scan.js');
}

/** The inputs a job names in its configuration, before it runs. */
function declaredInputs(job: GolemJob): readonly string[] {
  if (job.kind === 'openapi') return [job.options.input];
  if (job.kind === 'generator') return [];
  return [job.options.root, ...(job.options.sources ?? [])];
}

/** Whether a record's inputs include any of `outputs`: a job downstream of one that ran. */
function readsAny(config: GolemConfig, record: JobRecord, outputs: ReadonlySet<string>): boolean {
  return Object.keys(record.inputs).some(input => outputs.has(absoluteRecordPath(config, input)));
}

/** Select source consumers and then follow generated-artifact edges in pipeline order. */
function affectedJobs(config: GolemConfig, options: PipelineOptions): ReadonlySet<string> | undefined {
  const previous = options.previous;
  if (!previous || !options.changedInputs || options.check) return undefined;
  if (JSON.stringify(config.jobs) !== JSON.stringify(previous.config.jobs)) return undefined;
  const changed = new Set(options.changedInputs.map(input => path.resolve(input)));
  if (changed.has(config.configFile)) return undefined;
  const affected = new Set<string>();
  for (const input of changed) {
    for (const id of previous.dependencies.get(input) ?? []) affected.add(id);
    // Newly discovered source files do not have dependency records yet.
    for (const job of config.jobs) {
      if (job.kind === 'openapi') {
        if (input === job.options.input) affected.add(job.id);
      } else if (job.kind === 'generator') {
        // A generator job has no input pattern; it reruns from its recorded watchInputs or a config change.
      } else if (job.options.sources?.includes(input)
        || (!job.options.sources && isInsideDirectory(path.join(job.options.root, 'src'), input)
          && suffixPattern(job.options.suffixes ?? (job.kind === 'controllers' ? DEFAULT_CONTROLLER_SUFFIXES : DEFAULT_MODEL_SUFFIXES)).test(path.basename(input)))) affected.add(job.id);
    }
  }
  // An unclassified input can be a previously missing resolution dependency.
  if (affected.size === 0) return undefined;
  for (const job of config.jobs) {
    if (!affected.has(job.id)) continue;
    // A job the job cache skipped has no result; its recorded outputs are the same edges.
    const outputs = previous.results.get(job.id)?.artifacts.map(artifact => artifact.path) ?? previous.skippedOutputs.get(job.id) ?? [];
    for (const output of outputs) {
      for (const consumer of previous.dependencies.get(output) ?? []) affected.add(consumer);
      for (const consumer of config.jobs) {
        if (consumer.kind === 'openapi' && consumer.options.input === output) affected.add(consumer.id);
      }
    }
  }
  return affected;
}

/** Records the inputs a run reads and which jobs read them, and reports each one to the host as it is seen. */
class InputObserver {
  readonly inputs = new Map<string, InputKind>();
  readonly dependencies = new Map<string, Set<string>>();

  constructor(private readonly onInput: PipelineOptions['onInput']) {}

  observe = (filename: string, kind: InputKind, jobId?: string): void => {
    const resolved = path.resolve(filename);
    const effective = strongestInputKind(this.inputs.get(resolved), kind);
    this.inputs.set(resolved, effective);
    if (jobId) {
      const consumers = this.dependencies.get(resolved) ?? new Set<string>();
      consumers.add(jobId);
      this.dependencies.set(resolved, consumers);
    }
    this.onInput?.(resolved, effective);
  };
}

/** What the steps of one run read and never replace: the caller's options, the provider resources and the input record. */
interface PipelineRun {
  readonly options: PipelineOptions;
  readonly session: GeneratorSessionResources;
  readonly observer: InputObserver;
}

/** What `planPipeline` decides before any job runs. */
interface PipelinePlan {
  readonly config: GolemConfig;
  readonly inventory: Inventory;
  /** The files the inventory records as generated. */
  readonly generated: ReadonlySet<string>;
  /** The job cache serves a run that holds nothing in memory; a watch run with `previous` reuses by its own rules. */
  readonly jobCache: boolean;
  readonly records: ReadonlyMap<string, JobRecord>;
  /** The ids of the jobs whose record still holds, judged before anything runs. */
  readonly current: ReadonlySet<string>;
  readonly providerCode: (job: GolemJob) => string | undefined;
  /** The jobs a watch run must rerun, or undefined when every job is judged on its own. */
  readonly affected: ReadonlySet<string> | undefined;
  /** The files removed with the jobs that are no longer configured. */
  readonly retired: readonly string[];
}

/** What the jobs before the current one left behind. Only `absorbOutcome` writes to it. */
interface PipelineProgress {
  readonly providers: Map<string, LoadedProvider>;
  /** The manifests a job receives: those of the jobs before it. */
  readonly manifests: string[];
  readonly results: Map<string, GolemResult>;
  readonly owned: Set<string>;
  readonly used: Map<string, Set<string>>;
  readonly ran: Set<string>;
  readonly reports: Map<string, JobReport>;
  readonly skippedOutputs: Map<string, readonly string[]>;
  readonly nextRecords: Map<string, JobRecord>;
  /** The outputs of the jobs that ran in this run: what a later job reads from them is not what its record holds. */
  readonly ranOutputs: Set<string>;
}

type JobOutcome =
  /** The job cache found the job current: nothing ran and nothing was written. */
  | { readonly kind: 'skipped'; readonly outputs: readonly string[]; readonly manifests: readonly string[] }
  /** A watch run reused the previous result. */
  | { readonly kind: 'reused'; readonly result: GolemResult }
  | {
    readonly kind: 'ran';
    readonly result: GolemResult;
    /** The provider keys the job retains, which the rewrite scan may add to. */
    readonly keys: Set<string>;
    /** Absent in `check`, which saves no record. */
    readonly record: JobRecord | undefined;
    /** The outputs this job wrote or replaced. */
    readonly writtenOutputs: readonly string[];
    /** The files `applyJob` wrote with new content or deleted. */
    readonly changes: FileChanges;
    /** Providers loaded because the plan skipped the job. */
    readonly loadedProviders: ReadonlyMap<string, LoadedProvider>;
  };

/** The errors `applyJob` threw. */
const failedWhileWriting = new WeakSet<object>();
/** The errors of a job that failed before it wrote anything. */
const failedBeforeWriting = new WeakSet<object>();

/** Whether `error` came from a job that failed before it wrote a file: that job's output is as its last good run left it. */
export function jobFailedBeforeWriting(error: unknown): boolean {
  return typeof error === 'object' && error !== null && failedBeforeWriting.has(error);
}

/** Two generators emitting one output is an error, also within one job. */
function assertUnowned(owned: ReadonlySet<string>, outputs: readonly string[]): void {
  const seen = new Set<string>();
  for (const output of outputs) {
    if (owned.has(output) || seen.has(output)) throw new Error(`Two generators emitted the same output: ${output}`);
    seen.add(output);
  }
}

/** Read the configuration and the records, decide which jobs run, and clear the outputs of removed jobs. */
async function planPipeline(filename: string, run: PipelineRun): Promise<{ readonly plan: PipelinePlan; readonly providers: ReadonlyMap<string, LoadedProvider> }> {
  const { options, observer } = run;
  const requestedConfig = path.resolve(filename);
  let canonicalConfig: string | undefined;
  try { canonicalConfig = fs.realpathSync.native(requestedConfig); } catch { /* resolveConfig reports the missing/invalid file */ }
  const config = resolveConfig(filename, input => {
    const resolved = path.resolve(input);
    // resolveConfig reports roots, sources, and generated inputs through the
    // same observer as the YAML file. Classify those paths from their jobs
    // below; only the YAML file itself is a config dependency.
    if (resolved === requestedConfig || resolved === canonicalConfig) observer.observe(input, 'config');
  });
  options.onConfig?.(config);
  // Config paths identify source jobs; only the configuration itself forces all jobs.
  for (const job of config.jobs) {
    if (job.kind === 'controllers') {
      for (const input of [job.options.root, ...(job.options.sources ?? [])]) observer.observe(input, 'controllers', job.id);
    } else if (job.kind === 'openapi') observer.observe(job.options.input, 'openapi', job.id);
    else if (job.kind === 'models') for (const input of [job.options.root, ...(job.options.sources ?? [])]) observer.observe(input, 'models', job.id);
  }
  validateConfigInputs(config);
  const inventory = loadInventory(config);
  // The record is local state in the ignored .golem folder. Without it every generated file would read as stale.
  if (options.check && !fs.existsSync(config.inventoryFile)) throw new Error('No generation record (.golem/outputs.json does not exist). Run golem generate or golem build first.');
  const generated = inventoryPaths(config, inventory);
  const jobCache = !options.check && !options.previous;
  const records = options.check ? new Map<string, JobRecord>() : loadJobRecords(config);
  // The outputs of removed jobs go before the first job runs, so a job that reads one is not current.
  const active = new Set(config.jobs.map(job => job.id));
  const retired = new Set(Object.entries(inventory.files).filter(([, entry]) => !active.has(entry.job)).map(([key]) => path.resolve(config.directory, key)));
  const providerCodes = new Map<string, string | undefined>();
  const codeOf = (job: GolemJob): string | undefined => {
    if (!providerCodes.has(job.package)) providerCodes.set(job.package, providerCode(config, job));
    return providerCodes.get(job.package);
  };
  const current = new Set<string>();
  // The manifests a job receives are those of the jobs before it; their records say what to expect before anything runs.
  const expectedManifests: string[] = [];
  if (jobCache) {
    for (const job of config.jobs) {
      const record = records.get(job.id);
      if (record && !readsAny(config, record, retired)
        && jobIsCurrent(config, job, record, { providerCode: codeOf(job), manifestInputs: expectedManifests }, inventory, options.ignoredDirectories ?? [])) current.add(job.id);
      expectedManifests.push(...(record?.manifests ?? []).map(manifest => absoluteRecordPath(config, manifest)));
    }
  }
  // Jobs that must run, with the providers they need: a stale job, and each job that reads an output of one that runs.
  const planned = new Set<string>();
  const plannedOutputs = new Set<string>();
  for (const job of config.jobs) {
    const record = records.get(job.id);
    if (jobCache && record && current.has(job.id) && !readsAny(config, record, plannedOutputs)) continue;
    planned.add(job.id);
    for (const output of record?.outputs ?? []) plannedOutputs.add(absoluteRecordPath(config, output));
  }
  const providers = await providersFor(config, jobCache ? planned : undefined);
  options.onOwned?.([config.inventoryFile, ...Object.keys(inventory.files).map(key => path.resolve(config.directory, key))]);
  const retiredFiles = removeRetiredJobs(config, inventory, Boolean(options.check), options.files);
  return { plan: { config, inventory, generated, jobCache, records, current, providerCode: codeOf, affected: affectedJobs(config, options), retired: retiredFiles }, providers };
}

/** Start the accumulator with the records of the jobs still configured. */
function startProgress(plan: PipelinePlan, providers: ReadonlyMap<string, LoadedProvider>): PipelineProgress {
  const active = new Set(plan.config.jobs.map(job => job.id));
  return {
    providers: new Map(providers),
    manifests: [],
    results: new Map(),
    owned: new Set([plan.config.inventoryFile]),
    used: new Map(),
    ran: new Set(),
    reports: new Map(),
    skippedOutputs: new Map(),
    nextRecords: new Map([...plan.records].filter(([id]) => active.has(id))),
    ranOutputs: new Set(),
  };
}

/** Decide whether one job is skipped, reused or run; run it, write its output, and return what it left for the jobs after it. */
async function runJob(job: GolemJob, run: PipelineRun, plan: PipelinePlan, progress: PipelineProgress): Promise<JobOutcome> {
  const { options, session, observer } = run;
  const { config, inventory } = plan;
  const ignoredDirectories = options.ignoredDirectories ?? [];
  const previous = options.previous?.results.get(job.id);
  const previousJob = options.previous?.config.jobs.find(candidate => candidate.id === job.id);
  const cached = !options.check
    && (plan.affected ? !plan.affected.has(job.id) : options.modelOnly && (job.kind === 'controllers' || job.kind === 'openapi' || job.kind === 'generator'))
    && previous
    && JSON.stringify(previousJob?.options) === JSON.stringify(job.options);
  const record = plan.records.get(job.id);
  if (plan.jobCache && record && plan.current.has(job.id) && !readsAny(config, record, progress.ranOutputs) && sameSetup(config, record, { providerCode: plan.providerCode(job), manifestInputs: progress.manifests })) {
    // Its inputs and outputs are as its record holds them: there is no result to reuse, and nothing to write.
    const outputs = record.outputs.map(output => absoluteRecordPath(config, output));
    assertUnowned(progress.owned, outputs);
    options.onOwned?.(outputs);
    for (const input of Object.keys(record.inputs)) observer.observe(absoluteRecordPath(config, input), job.kind, job.id);
    // The job's inputs are as they were, so its warnings still hold: each run writes them once.
    writeWarnings(record.warnings);
    return { kind: 'skipped', outputs, manifests: record.manifests.map(manifest => absoluteRecordPath(config, manifest)) };
  }
  if (cached) {
    for (const [input, consumers] of options.previous?.dependencies ?? []) {
      if (consumers.has(job.id)) observer.observe(input, job.kind, job.id);
    }
    assertNoDiagnosticErrors(job, previous);
    assertUnowned(progress.owned, previous.artifacts.map(artifact => artifact.path));
    options.onOwned?.(previous.artifacts.map(artifact => artifact.path));
    for (const input of previous.watchInputs) observer.observe(input, job.kind, job.id);
    return { kind: 'reused', result: previous };
  }
  // The job's own earlier outputs are not inputs: its record and its directory listings leave them out.
  const previousOutputs = new Set([
    ...(record?.outputs ?? []).map(output => absoluteRecordPath(config, output)),
    ...Object.entries(inventory.files).filter(([, entry]) => entry.job === job.id).map(([key]) => path.resolve(config.directory, key)),
  ]);
  // The tsconfig the job analyses with is named before it runs, so a failure that the tsconfig explains still names it.
  writeWarnings(jobTsconfigDiagnostics(config, job));
  const loadedProviders = new Map<string, LoadedProvider>();
  let provider = progress.providers.get(job.package);
  if (!provider) {
    // A job the plan skipped reads an output that the run just changed.
    for (const [name, loaded] of await providersFor(config, new Set([job.id]))) loadedProviders.set(name, loaded);
    provider = loadedProviders.get(job.package);
  }
  if (!provider) throw new Error(`Missing loaded provider ${job.package}.`);
  const keys = new Set<string>();
  const read = options.check ? undefined : new JobInputs(filename => plan.generated.has(filename) || previousOutputs.has(filename) || progress.ranOutputs.has(filename) || insideAny(ignoredDirectories, filename), config.directory);
  for (const input of declaredInputs(job)) read?.read(input);
  let generatedResult: unknown;
  try {
    generatedResult = await provider.generate({
      ...job.options,
      manifestInputs: [...progress.manifests],
      onInput: (input: string) => { observer.observe(input, job.kind); read?.read(input); },
      session: session.forJob(job.id, keys),
    });
  } catch (error) {
    // A package's generator failure names the package; built-in generators report their own diagnostics.
    if (job.kind === 'generator') throw new Error(`Generator ${job.package} failed for ${job.id}: ${errorMessage(error)}`, { cause: error });
    throw error;
  }
  const result = validateResult(generatedResult, job);
  const nextRecord = read && {
    golemCode: golemCode(),
    providerCode: plan.providerCode(job) ?? '',
    options: JSON.stringify(job.options),
    manifestInputs: progress.manifests.map(manifest => recordPath(config, manifest)),
    inputs: read.finish(config, result.watchInputs, new Set([...previousOutputs, ...result.artifacts.map(artifact => artifact.path)])),
    outputs: result.artifacts.map(artifact => recordPath(config, artifact.path)).sort(),
    manifests: result.manifestPaths.map(manifest => recordPath(config, manifest)),
    warnings: (result.diagnostics ?? []).filter(diagnostic => diagnostic.severity === GolemDiagnosticSeverity.Warning),
  };
  assertNoDiagnosticErrors(job, result);
  writeWarnings(result.diagnostics ?? []);
  assertUnowned(progress.owned, result.artifacts.map(artifact => artifact.path));
  options.onOwned?.(result.artifacts.map(artifact => artifact.path));
  let changes: FileChanges;
  try {
    changes = applyJob(config, inventory, job, result.artifacts, Boolean(options.check), options.files);
  } catch (error) {
    // The write loop may have changed files before it threw, so this failure is not one that left the job's output as it was.
    if (typeof error === 'object' && error !== null) failedWhileWriting.add(error);
    throw error;
  }
  // The job's record and its written output change together: a later job's failure leaves a record that matches the files.
  if (nextRecord) saveJobRecords(config, new Map(progress.nextRecords).set(job.id, nextRecord));
  for (const input of result.watchInputs) observer.observe(input, job.kind, job.id);
  return {
    kind: 'ran',
    result,
    keys,
    record: nextRecord,
    writtenOutputs: [...previousOutputs, ...result.artifacts.map(artifact => artifact.path)],
    changes,
    loadedProviders,
  };
}

/** Add what one job left behind to the accumulator. */
function absorbOutcome(progress: PipelineProgress, job: GolemJob, outcome: JobOutcome, ms: number): void {
  if (outcome.kind === 'skipped') {
    for (const output of outcome.outputs) progress.owned.add(output);
    progress.manifests.push(...outcome.manifests);
    progress.skippedOutputs.set(job.id, outcome.outputs);
    return;
  }
  for (const artifact of outcome.result.artifacts) progress.owned.add(artifact.path);
  if (outcome.kind === 'ran') {
    for (const [name, provider] of outcome.loadedProviders) progress.providers.set(name, provider);
    progress.ran.add(job.id);
    progress.reports.set(job.id, { ...outcome.changes, ms });
    progress.used.set(job.id, outcome.keys);
    if (outcome.record) progress.nextRecords.set(job.id, outcome.record);
    for (const output of outcome.writtenOutputs) progress.ranOutputs.add(output);
  }
  progress.manifests.push(...outcome.result.manifestPaths);
  progress.results.set(job.id, outcome.result);
}

/**
 * `golem check` reads the project's sources too: it reports the sites golem cannot rewrite, and writes nothing. A yaml
 * without a tsconfig, an openapi-only one for instance, has no project to scan.
 */
async function scanRewriteSites(config: GolemConfig, session: GeneratorSessionResources, used: Map<string, Set<string>>): Promise<void> {
  const rewriteScan = fs.existsSync(config.tsconfig) ? await loadRewriteScan(rewriteRoot(config).job !== undefined) : undefined;
  if (!rewriteScan) return;
  const { job, root, controllerRoots } = rewriteRoot(config);
  const nest = controllerRoots.length > 0;
  const keys = job ? used.get(job.id) ?? new Set<string>() : undefined;
  if (job && keys) used.set(job.id, keys);
  const scanned = rewriteScan.scanProject({
    root,
    directory: config.directory,
    modelsRoot: modelsRootOf(config),
    suffixes: job?.kind === 'models' ? job.options.suffixes : undefined,
    output: job?.kind === 'models' ? job.options.output : undefined,
    configFile: config.tsconfig,
    nest,
    nonModelInputs: config.nonModelInputs,
    codecKeysFile: codecKeysPath(config.directory),
    // Without a job there is no compiler to borrow; the scan opens its own and closes it when idle.
    ...(job && keys ? {
      session: session.forJob(job.id, keys),
      // The models job's compiler is its retained session, keyed by golem-model's SESSION_OWNER, which is its package name.
      sessionOwner: job.package,
    } : {}),
  });
  const errors = scanned.diagnostics.filter(diagnostic => diagnostic.severity === GolemDiagnosticSeverity.Error);
  if (errors.length > 0) throw new Error(errorDiagnosticsMessage('golem rewrite scan', errors));
  writeWarnings(scanned.diagnostics);
  const disagreements = nest ? rewriteScan.checkNestCodecs(controllerRoots, scanned) : [];
  if (disagreements.length > 0) throw new Error(errorDiagnosticsMessage('golem nest codec check', disagreements));
}

/** Scan the sources for `check`, save the records of the jobs still configured, and hand the provider keys back to the session. */
async function finalizePipeline(run: PipelineRun, plan: PipelinePlan, progress: PipelineProgress): Promise<PipelineState> {
  const { options, session, observer } = run;
  const { config } = plan;
  const used = new Map(progress.used);
  if (options.check) await scanRewriteSites(config, session, used);
  // The last save drops the records of removed jobs, which a run where every job is current has not saved. `check` writes nothing.
  if (!options.check) saveJobRecords(config, progress.nextRecords);
  for (const output of progress.owned) observer.inputs.delete(output);
  session.retainUsed(new Set(config.jobs.map((job) => job.id)), used);
  return { config, results: progress.results, inputs: observer.inputs, dependencies: observer.dependencies, owned: progress.owned, ran: progress.ran, reports: progress.reports, retired: plan.retired, skippedOutputs: progress.skippedOutputs };
}

export async function runPipeline(filename: string, options: PipelineOptions = {}): Promise<PipelineState> {
  const session = options.session ?? new GeneratorSessionResources();
  using ownedSession = options.session ? undefined : session;
  const run: PipelineRun = { options, session, observer: new InputObserver(options.onInput) };
  const { plan, providers } = await planPipeline(filename, run);
  const progress = startProgress(plan, providers);
  for (const job of plan.config.jobs) {
    const started = performance.now();
    let outcome: JobOutcome;
    try {
      outcome = await runJob(job, run, plan, progress);
    } catch (error) {
      if (typeof error === 'object' && error !== null && !failedWhileWriting.has(error)) failedBeforeWriting.add(error);
      throw error;
    }
    absorbOutcome(progress, job, outcome, Math.round(performance.now() - started));
  }
  return await finalizePipeline(run, plan, progress);
}
