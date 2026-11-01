import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalPath, displayPath, invalidValidationLevelMessage, isInsideDirectory, isRecord, isValidationLevel, parseYamlFile, resolveProfile } from './generator-core.js';
import { ROOT_KEYS } from './editor-schema.js';
import { providersOf, resolveJobPlan } from './job-rules.js';
import { loadPackageRegistry, PackageRegistryError, registrationForBlock } from './package-registry.js';
import type { PackageRegistration, PackageRegistry } from './package-registry.js';
import type { EnabledExtension } from './rewrite-participant.js';
import { MODEL_BOUNDARY } from './job-facts.js';
import type { JobFacts, JobPlan } from './job-facts.js';
import type {
  ContractValues,
  GolemJob,
  GolemPlanEntry,
  GolemProfile,
  InputObserver,
  JobPlanParts,
  PlanContext,
  PlannedJob,
} from './generator-core.js';

export type { GolemJob };

export interface GolemConfig {
  readonly configFile: string;
  readonly directory: string;
  /** The project's tsconfig: where `golem generate` and `golem build` start. Its directory is the project root a rewrite names files from. A tsconfig the yaml names exists; the default beside the yaml need not. */
  readonly tsconfig: string;
  readonly profile: GolemProfile;
  /** The jobs of every block, in run order. */
  readonly jobs: readonly GolemJob[];
  /** What core derived from the facts of the jobs: the run order, the provider of each contract and what each program reader sees of the later jobs. */
  readonly jobPlan: JobPlan;
  /** The value of each contract that a job provides. */
  readonly contracts: ContractValues;
  /** The extensions that the blocks turn on, in the order of golem.yaml: each is an entry under `extensions:` in a block. None is loaded here: a rewrite host loads them when it starts. */
  readonly extensions: readonly EnabledExtension[];
  readonly inventoryFile: string;
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function validationLevel(value: unknown): GolemProfile['validation'] {
  if (value === undefined) return true;
  if (!isValidationLevel(value)) throw new TypeError(invalidValidationLevelMessage('validation'));
  return value;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function existing(filename: string, kind: 'directory' | 'file', label: string): void {
  let stat: fs.Stats;
  try { stat = fs.statSync(filename); } catch { throw new Error(`${label} does not exist: ${displayPath(filename)}`); }
  if (!(kind === 'directory' ? stat.isDirectory() : stat.isFile())) throw new Error(`${label} must be a ${kind}: ${displayPath(filename)}`);
}

/** A file's name under its canonical directory: a link to the file is not followed, so the file stays where it is named. */
export function canonicalFile(filename: string): string {
  const resolved = path.resolve(filename);
  return path.join(canonicalPath(path.dirname(resolved)), path.basename(resolved));
}

/** The plan entry of `registration`: the module that its `golem.plan` names exports it as `plan`. The module is light; `import()` loads it, because `require()` of an ES module fails inside a Node loader hook. Its `declare` and `link` are synchronous. */
async function loadPlanEntry(registration: PackageRegistration): Promise<GolemPlanEntry> {
  if (registration.plan === undefined) throw new PackageRegistryError(`${registration.name} registers the golem block "${registration.block}" but declares no golem.plan entry, so golem cannot read its block.`);
  let loaded: unknown;
  try { loaded = await import(pathToFileURL(registration.plan).href); }
  catch (error) { throw new PackageRegistryError(`Cannot load the plan entry of ${registration.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const entry = isRecord(loaded) ? loaded.plan : undefined;
  if (!isRecord(entry) || typeof entry.declare !== 'function') throw new PackageRegistryError(`The plan entry of ${registration.name} must export "plan" with a declare function.`);
  return entry as unknown as GolemPlanEntry;
}

/** The plan entry's answer for one block, checked: an array of jobs that carry facts, options and the values of the contracts they provide. */
function plannedJobs(registration: PackageRegistration, planned: unknown): readonly PlannedJob[] {
  if (!Array.isArray(planned)) throw new PackageRegistryError(`The plan entry of ${registration.name} must return an array of jobs.`);
  for (const job of planned) {
    if (!isRecord(job) || !isRecord(job.facts) || typeof job.facts.id !== 'string' || !job.facts.id) {
      throw new PackageRegistryError(`The plan entry of ${registration.name} must return jobs whose facts hold a nonempty id.`);
    }
    for (const contract of Array.isArray(job.facts.provides) ? job.facts.provides : []) {
      if (!isRecord(job.provided) || job.provided[String(contract)] === undefined) {
        throw new PackageRegistryError(`Job ${job.facts.id} of ${registration.name} provides the contract ${String(contract)} but returns no value for it.`);
      }
      // Core reads the suffixes of the model boundary to find the model files; a provider that leaves them out would fail later.
      const boundary = job.provided[String(contract)];
      if (contract === MODEL_BOUNDARY && !(isRecord(boundary) && Array.isArray(boundary.suffixes) && boundary.suffixes.every(suffix => typeof suffix === 'string'))) {
        throw new PackageRegistryError(`Job ${job.facts.id} of ${registration.name} provides the contract ${MODEL_BOUNDARY} whose value must hold "suffixes", an array of strings.`);
      }
    }
  }
  return planned as readonly PlannedJob[];
}

/**
 * The extensions that a block turns on: the names under its `extensions:` key, each with its options. A name the block's package does
 * not register stops loading and lists the extensions that it registers. Core reads only these names; the package validates the rest of its block.
 */
function enabledExtensions(registration: PackageRegistration, block: string, value: unknown): readonly EnabledExtension[] {
  const declared = isRecord(value) ? value.extensions : undefined;
  if (declared === undefined) return [];
  if (!isRecord(declared)) throw new TypeError(`${block}.extensions must map an extension name to its options.`);
  return Object.entries(declared).map(([name, options]) => {
    const registered = registration.extensions.get(name);
    if (registered === undefined) {
      const names = [...registration.extensions.keys()];
      throw new PackageRegistryError(`${block}.extensions turns on "${name}", which ${registration.name} does not register. ${names.length ? `It registers: ${names.join(', ')}.` : 'It registers no extension.'}`);
    }
    // A bare `name:` in YAML is null: an extension with no options.
    if (options !== null && !isRecord(options)) throw new TypeError(`${block}.extensions.${name} must be an object of options.`);
    return { package: registration.name, block, name, entry: registered.entry, options: options ?? {} };
  });
}

/**
 * The options of the enabled extensions that their package flags `profile: true`, as golem.yaml writes them, by package and extension name.
 * An extension with no flag adds nothing: it changes no generated code.
 */
function profileExtensions(registry: PackageRegistry, enabled: readonly EnabledExtension[]): Record<string, Record<string, unknown>> {
  const recorded: Record<string, Record<string, unknown>> = {};
  for (const { package: owner, block, name, options } of enabled) {
    if (registrationForBlock(registry, block).extensions.get(name)?.profile) (recorded[owner] ??= {})[name] = options;
  }
  return recorded;
}

/** Parse and resolve the complete dependency graph before checking existence. */
export async function resolveConfig(filename = 'golem.yaml', onInput?: InputObserver): Promise<GolemConfig> {
  const requested = path.resolve(filename);
  onInput?.(requested);
  const configFile = fs.realpathSync.native(requested);
  onInput?.(configFile);
  const directory = path.dirname(configFile);
  const value: unknown = parseYamlFile(fs.readFileSync(configFile, 'utf8'), configFile, { uniqueKeys: true });
  if (!isRecord(value)) throw new TypeError('configuration must be an object.');
  if (value.version !== 1) throw new Error('Configuration version must be 1.');
  if (value.unknownFormats !== undefined && value.unknownFormats !== 'warn' && value.unknownFormats !== 'error') throw new Error('unknownFormats must be "warn" or "error".');
  const settings: GolemProfile = {
    mobx: boolean(value.mobx, false, 'mobx'), validation: validationLevel(value.validation),
    allowAny: boolean(value.allowAny, false, 'allowAny'),
    ...(value.unknownFormats === undefined ? {} : { unknownFormats: value.unknownFormats }),
  };
  const exact = value.exact === undefined ? undefined : boolean(value.exact, true, 'exact');
  const tsconfigRequested = path.resolve(directory, value.tsconfig === undefined ? 'tsconfig.json' : nonempty(value.tsconfig, 'tsconfig'));
  onInput?.(tsconfigRequested);
  // The directory is canonical and the file keeps its name: a linked tsconfig.json belongs to the directory that holds the link.
  const tsconfig = canonicalFile(tsconfigRequested);
  onInput?.(tsconfig);

  const registry = loadPackageRegistry(configFile);
  for (const { name, block } of registry.packages) {
    if (ROOT_KEYS.includes(block)) throw new PackageRegistryError(`${name} registers the golem block "${block}", which is a root key of golem.yaml. Core reads the root keys (${ROOT_KEYS.join(', ')}); the package must register another block name.`);
  }
  const blocks = Object.keys(value).filter(key => !ROOT_KEYS.includes(key));
  if (!blocks.length) {
    const installed = registry.packages.map(({ name, block }) => `${name} (block ${block})`);
    throw new Error(`Configure at least one golem block. ${installed.length ? `Installed golem packages and their blocks: ${installed.join(', ')}.` : 'No installed package registers a golem block.'}`);
  }

  // The extensions are read before pass 1: the profile that the plans receive records the options of those that change generated code.
  const extensions = blocks.flatMap(block => enabledExtensions(registrationForBlock(registry, block), block, value[block]));
  const profile = resolveProfile({ ...settings, extensions: profileExtensions(registry, extensions) });

  // Pass 1: each package validates its block and declares its jobs with their facts.
  const entries = new Map<string, { registration: PackageRegistration; entry: GolemPlanEntry; planned: readonly PlannedJob[] }>();
  const ids = new Map<string, string>();
  for (const block of blocks) {
    const registration = registrationForBlock(registry, block);
    const entry = await loadPlanEntry(registration);
    const context: PlanContext = { configFile, directory, tsconfig, profile, ...(exact === undefined ? {} : { exact }), block: value[block], ...(onInput ? { onInput } : {}) };
    const planned = plannedJobs(registration, entry.declare(context));
    for (const { facts } of planned) {
      const previous = ids.get(facts.id);
      if (previous !== undefined) throw new Error(`Job id ${facts.id} is declared twice, by ${previous} and ${registration.name}. A job id is unique in one golem.yaml.`);
      ids.set(facts.id, registration.name);
    }
    entries.set(block, { registration, entry, planned });
  }
  if (!ids.size) throw new Error('Configure at least one job: the blocks of golem.yaml declare none.');

  // Pass 2: each package gets the values of the contracts its jobs need, from the one job that provides each (a missing or doubled provider stops here).
  const pass1 = [...entries.values()].flatMap(({ planned }) => planned);
  const providers = providersOf(pass1.map(job => job.facts));
  const provided = new Map(pass1.map(job => [job.facts.id, job] as const));
  const contracts: Record<string, unknown> = {};
  for (const [contract, id] of Object.entries(providers)) contracts[contract] = provided.get(id)?.provided?.[contract];
  const jobs: GolemJob[] = [];
  for (const [block, { registration, entry, planned }] of entries) {
    for (const job of planned) {
      const received = [...job.facts.needs, ...(job.facts.wants ?? []).filter(contract => providers[contract] !== undefined)];
      const needed = Object.fromEntries(received.map(contract => [contract, contracts[contract]]));
      const consumers = Object.fromEntries(job.facts.provides.map(contract => [contract, pass1.filter(other => other !== job && [...other.facts.needs, ...(other.facts.wants ?? [])].includes(contract)).map((other): JobFacts => other.facts)]));
      const linked: JobPlanParts = entry.link ? entry.link(job, { needed, consumers }) : job;
      if (linked.facts.id !== job.facts.id) throw new Error(`The plan entry of ${registration.name} changed the id of job ${job.facts.id} in the second pass.`);
      jobs.push({ id: linked.facts.id, package: registration.name, block, facts: linked.facts, options: linked.options });
    }
  }

  const jobPlan = resolveJobPlan(jobs.map(job => job.facts), { configFile, tsconfigDirectory: path.dirname(tsconfig) });
  // A misspelled path is that, not a tsconfig the jobs happen to find elsewhere.
  if (value.tsconfig !== undefined) existing(tsconfig, 'file', 'tsconfig');
  const byId = new Map(jobs.map(job => [job.id, job] as const));
  return {
    configFile, directory, tsconfig, profile,
    jobs: jobPlan.order.map(id => byId.get(id) as GolemJob), jobPlan, contracts, extensions,
    inventoryFile: path.join(directory, '.golem', 'outputs.json'),
  };
}

/** Whether an earlier job's exclusive output holds `input`. */
function writtenBefore(jobs: readonly GolemJob[], input: string): boolean {
  return jobs.some(job => job.facts.outputs.some(output => output.kind === 'file' ? output.path === input : isInsideDirectory(output.path, input)));
}

/** Whether an earlier job writes into `root`, or writes a folder that holds it: the folder exists once that job has run. */
function writtenInside(jobs: readonly GolemJob[], root: string): boolean {
  return jobs.some(job => job.facts.outputs.some(output => isInsideDirectory(root, output.path) || isInsideDirectory(output.path, root)));
}

export function validateConfigInputs(config: GolemConfig): void {
  for (const [index, job] of config.jobs.entries()) {
    const earlier = config.jobs.slice(0, index);
    // A root or an input that an earlier job writes is absent on a clean clone until that job runs. Rule 1 keeps a producer before its reader.
    for (const root of [...job.facts.ownedRoots, ...(job.facts.scanRoots ?? [])]) if (!writtenInside(earlier, root)) existing(root, 'directory', `Job ${job.id}: root`);
    for (const input of job.facts.inputFiles) if (!writtenBefore(earlier, input)) existing(input, 'file', `Job ${job.id}: input file`);
    for (const output of job.facts.outputs) {
      if (fs.existsSync(output.path) && fs.statSync(output.path).isDirectory() !== (output.kind === 'folder')) throw new Error(`Job ${job.id}: output must be a ${output.kind}: ${displayPath(output.path)}`);
    }
  }
}
