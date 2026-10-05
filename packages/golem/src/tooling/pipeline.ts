import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { contains, resolveConfig, validateConfigInputs } from './config.js';
import type { GolemConfig, GolemJob } from './config.js';
import { codecKeysPath } from './generated-paths.js';
import { loadInventory, applyJob, removeRetiredJobs } from './outputs.js';
import { absoluteRecordPath, insideAny, inventoryPaths, JobInputs, jobIsCurrent, loadJobRecords, recordPath, sameSetup, saveJobRecords } from './job-cache.js';
import type { JobRecord } from './job-cache.js';
import { DEFAULT_CONTROLLER_SUFFIXES, DEFAULT_MODEL_SUFFIXES, GolemDiagnosticSeverity, errorMessage, hasErrorCode, isRecord, suffixPattern } from './generator-api.js';
import { validateModelManifest } from './model-manifest.js';
import type { GolemArtifact, GolemDiagnostic, GolemResult, GeneratorSession } from './generator-api.js';
import { assertRuntimeCompatible } from './runtime-compatibility.js';
import { TypeScriptNotInstalledError, resolveTypeScript } from './typescript-version.js';
import { GOLEM_VERSION } from './version.js';

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
export interface PipelineState {
  readonly config: GolemConfig;
  readonly results: ReadonlyMap<string, GolemResult>;
  readonly inputs: ReadonlyMap<string, InputKind>;
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly owned: ReadonlySet<string>;
  /** The ids of the jobs that executed in this run; a job reused from `previous` or skipped by the job cache is not in it. */
  readonly ran: ReadonlySet<string>;
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
    const resources = [...this.jobs.values()].flatMap((job) => [...job.values()]);
    this.jobs.clear();
    disposeAll(resources);
  }
}

/**
 * The npm dist-tag matching this golem release: the prerelease channel
 * (`1.0.0-rc` or `1.0.0-rc.2` → `rc`), or `latest` for a stable version.
 * Generator packages are published in lockstep under the same tag.
 */
export function golemDistTag(version: string = golemVersion()): string {
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1];
  return prerelease ?? 'latest';
}

export function golemVersion(): string {
  // dist/tooling/pipeline.js → package.json of @exprtlabs/golem.
  const manifest: unknown = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (!isRecord(manifest) || typeof manifest.version !== 'string') throw new Error('@exprtlabs/golem package.json has no version.');
  return manifest.version;
}

/** Version of the package that owns `filename`, found by walking up to its package.json. */
function packageVersion(specifier: string, filename: string): string {
  for (let directory = path.dirname(filename); ; directory = path.dirname(directory)) {
    const manifestFile = path.join(directory, 'package.json');
    if (fs.existsSync(manifestFile)) {
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (isRecord(manifest) && manifest.name === specifier) {
        if (typeof manifest.version !== 'string') throw new Error(`${specifier} package.json has no version.`);
        return manifest.version;
      }
    }
    if (path.dirname(directory) === directory) throw new Error(`Cannot find the package.json of ${specifier}.`);
  }
}

/** The version of the package that provides a job, or undefined when it cannot be resolved. */
function providerVersion(config: GolemConfig, job: GolemJob): string | undefined {
  try {
    return packageVersion(job.package, createRequire(path.join(config.directory, 'package.json')).resolve(`${job.package}/generator`));
  } catch {
    return undefined;
  }
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
      if (hasErrorCode(error, 'MODULE_NOT_FOUND')) throw new Error(`${job.kind} is configured but ${job.package} is not installed in ${config.directory}. Install it with npm install -D ${job.package}@${golemDistTag()}.`);
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
      resolveTypeScript(process.env.GOLEM_TYPESCRIPT_ROOT ?? process.cwd());
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
        || (!job.options.sources && contains(path.join(job.options.root, 'src'), input)
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

export async function runPipeline(filename: string, options: PipelineOptions = {}): Promise<PipelineState> {
  const ignoredDirectories = options.ignoredDirectories ?? [];
  const session = options.session ?? new GeneratorSessionResources();
  using ownedSession = options.session ? undefined : session;
  const inputs = new Map<string, InputKind>();
  const dependencies = new Map<string, Set<string>>();
  const observe = (filename: string, kind: InputKind, jobId?: string): void => {
    const resolved = path.resolve(filename);
    const effective = strongestInputKind(inputs.get(resolved), kind);
    inputs.set(resolved, effective);
    if (jobId) {
      const consumers = dependencies.get(resolved) ?? new Set<string>();
      consumers.add(jobId);
      dependencies.set(resolved, consumers);
    }
    options.onInput?.(resolved, effective);
  };
  const requestedConfig = path.resolve(filename);
  let canonicalConfig: string | undefined;
  try { canonicalConfig = fs.realpathSync.native(requestedConfig); } catch { /* resolveConfig reports the missing/invalid file */ }
  const config = resolveConfig(filename, input => {
    const resolved = path.resolve(input);
    // resolveConfig reports roots, sources, and generated inputs through the
    // same observer as the YAML file. Classify those paths from their jobs
    // below; only the YAML file itself is a config dependency.
    if (resolved === requestedConfig || resolved === canonicalConfig) observe(input, 'config');
  });
  options.onConfig?.(config);
  // Config paths identify source jobs; only the configuration itself forces all jobs.
  for (const job of config.jobs) {
    if (job.kind === 'controllers') {
      for (const input of [job.options.root, ...(job.options.sources ?? [])]) observe(input, 'controllers', job.id);
    } else if (job.kind === 'openapi') observe(job.options.input, 'openapi', job.id);
    else if (job.kind === 'models') for (const input of [job.options.root, ...(job.options.sources ?? [])]) observe(input, 'models', job.id);
  }
  validateConfigInputs(config);
  const inventory = loadInventory(config);
  const generated = inventoryPaths(config, inventory);
  // The job cache serves a run that holds nothing in memory; a watch run with `previous` reuses by its own rules.
  const jobCache = !options.check && !options.previous;
  const records = options.check ? new Map<string, JobRecord>() : loadJobRecords(config);
  // The outputs of removed jobs go before the first job runs, so a job that reads one is not current.
  const active = new Set(config.jobs.map(job => job.id));
  const retired = new Set(Object.entries(inventory.files).filter(([, entry]) => !active.has(entry.job)).map(([key]) => path.resolve(config.directory, key)));
  const providerVersions = new Map<string, string | undefined>();
  const versionOf = (job: GolemJob): string | undefined => {
    if (!providerVersions.has(job.package)) providerVersions.set(job.package, providerVersion(config, job));
    return providerVersions.get(job.package);
  };
  const current = new Set<string>();
  // The manifests a job receives are those of the jobs before it; their records say what to expect before anything runs.
  const expectedManifests: string[] = [];
  if (jobCache) {
    for (const job of config.jobs) {
      const record = records.get(job.id);
      if (record && !readsAny(config, record, retired)
        && jobIsCurrent(config, job, record, { provider: versionOf(job), manifestInputs: expectedManifests }, inventory, ignoredDirectories)) current.add(job.id);
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
  const providers = new Map(await providersFor(config, jobCache ? planned : undefined));
  options.onOwned?.([config.inventoryFile, ...Object.keys(inventory.files).map(key => path.resolve(config.directory, key))]);
  removeRetiredJobs(config, inventory, Boolean(options.check));
  const affected = affectedJobs(config, options);
  const manifests: string[] = [];
  const results = new Map<string, GolemResult>();
  const owned = new Set<string>([config.inventoryFile]);
  const used = new Map<string, Set<string>>();
  const ran = new Set<string>();
  const skippedOutputs = new Map<string, readonly string[]>();
  const nextRecords = new Map([...records].filter(([id]) => active.has(id)));
  // The outputs of the jobs that ran in this run: what a later job reads from them is not what its record holds.
  const ranOutputs = new Set<string>();
  for (const job of config.jobs) {
    const previous = options.previous?.results.get(job.id);
    const previousJob = options.previous?.config.jobs.find(candidate => candidate.id === job.id);
    const cached = !options.check
      && (affected ? !affected.has(job.id) : options.modelOnly && (job.kind === 'controllers' || job.kind === 'openapi' || job.kind === 'generator'))
      && previous
      && JSON.stringify(previousJob?.options) === JSON.stringify(job.options);
    const record = records.get(job.id);
    if (jobCache && record && current.has(job.id) && !readsAny(config, record, ranOutputs) && sameSetup(config, record, { provider: versionOf(job), manifestInputs: manifests })) {
      // Its inputs and outputs are as its record holds them: there is no result to reuse, and nothing to write.
      const outputs = record.outputs.map(output => absoluteRecordPath(config, output));
      for (const output of outputs) {
        if (owned.has(output)) throw new Error(`Two generators emitted the same output: ${output}`);
        owned.add(output);
      }
      options.onOwned?.(outputs);
      for (const input of Object.keys(record.inputs)) observe(absoluteRecordPath(config, input), job.kind, job.id);
      manifests.push(...record.manifests.map(manifest => absoluteRecordPath(config, manifest)));
      skippedOutputs.set(job.id, outputs);
      continue;
    }
    // The job's own earlier outputs are not inputs: its record and its directory listings leave them out.
    const previousOutputs = new Set([
      ...(record?.outputs ?? []).map(output => absoluteRecordPath(config, output)),
      ...Object.entries(inventory.files).filter(([, entry]) => entry.job === job.id).map(([key]) => path.resolve(config.directory, key)),
    ]);
    let result: GolemResult;
    if (cached) {
      result = previous;
      for (const [input, consumers] of options.previous?.dependencies ?? []) {
        if (consumers.has(job.id)) observe(input, job.kind, job.id);
      }
    }
    else {
      ran.add(job.id);
      let provider = providers.get(job.package);
      if (!provider) {
        // A job the plan skipped reads an output that the run just changed.
        for (const [name, loaded] of await providersFor(config, new Set([job.id]))) providers.set(name, loaded);
        provider = providers.get(job.package);
      }
      if (!provider) throw new Error(`Missing loaded provider ${job.package}.`);
      const keys = new Set<string>();
      used.set(job.id, keys);
      const read = options.check ? undefined : new JobInputs(filename => generated.has(filename) || previousOutputs.has(filename) || ranOutputs.has(filename) || insideAny(ignoredDirectories, filename), config.directory);
      for (const input of declaredInputs(job)) read?.read(input);
      let generatedResult: unknown;
      try {
        generatedResult = await provider.generate({
          ...job.options,
          manifestInputs: [...manifests],
          onInput: (input: string) => { observe(input, job.kind); read?.read(input); },
          session: session.forJob(job.id, keys),
        });
      } catch (error) {
        // A package's generator failure names the package; built-in generators report their own diagnostics.
        if (job.kind === 'generator') throw new Error(`Generator ${job.package} failed for ${job.id}: ${errorMessage(error)}`, { cause: error });
        throw error;
      }
      result = validateResult(generatedResult, job);
      if (read) {
        const own = new Set([...previousOutputs, ...result.artifacts.map(artifact => artifact.path)]);
        nextRecords.set(job.id, {
          golem: GOLEM_VERSION,
          provider: versionOf(job) ?? '',
          options: JSON.stringify(job.options),
          manifestInputs: manifests.map(manifest => recordPath(config, manifest)),
          inputs: read.finish(config, result.watchInputs, own),
          outputs: result.artifacts.map(artifact => recordPath(config, artifact.path)).sort(),
          manifests: result.manifestPaths.map(manifest => recordPath(config, manifest)),
        });
      }
    }
    assertNoDiagnosticErrors(job, result);
    if (!cached) for (const diagnostic of result.diagnostics ?? []) {
      if (diagnostic.severity === GolemDiagnosticSeverity.Warning) process.stderr.write(`${diagnostic.code}${diagnosticLocation(diagnostic)}: ${diagnostic.message}\n`);
    }
    for (const artifact of result.artifacts) {
      if (owned.has(artifact.path)) throw new Error(`Two generators emitted the same output: ${artifact.path}`);
      owned.add(artifact.path);
    }
    options.onOwned?.(result.artifacts.map(artifact => artifact.path));
    if (!cached) {
      applyJob(config, inventory, job, result.artifacts, Boolean(options.check));
      for (const output of [...previousOutputs, ...result.artifacts.map(artifact => artifact.path)]) ranOutputs.add(output);
    }
    for (const input of result.watchInputs) observe(input, job.kind, job.id);
    manifests.push(...result.manifestPaths);
    results.set(job.id, result);
  }
  // `golem check` reads the project's sources too: it reports the sites golem cannot rewrite, and writes nothing. A yaml
  // without a tsconfig, an openapi-only one for instance, has no project to scan.
  const rewriteScan = options.check && fs.existsSync(config.tsconfig) ? await loadRewriteScan(rewriteRoot(config).job !== undefined) : undefined;
  if (rewriteScan) {
    const { job, root, controllerRoots } = rewriteRoot(config);
    const nest = controllerRoots.length > 0;
    const keys = job ? used.get(job.id) ?? new Set<string>() : undefined;
    if (job && keys) used.set(job.id, keys);
    const scanned = rewriteScan.scanProject({
      root,
      configFile: config.tsconfig,
      nest,
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
    const disagreements = nest ? rewriteScan.checkNestCodecs(controllerRoots, scanned) : [];
    if (disagreements.length > 0) throw new Error(errorDiagnosticsMessage('golem nest codec check', disagreements));
  }
  // Records are saved last, and only by a run that writes: `check` writes nothing.
  if (!options.check) saveJobRecords(config, nextRecords);
  for (const output of owned) inputs.delete(output);
  session.retainUsed(new Set(config.jobs.map((job) => job.id)), used);
  return { config, results, inputs, dependencies, owned, ran, skippedOutputs };
}
