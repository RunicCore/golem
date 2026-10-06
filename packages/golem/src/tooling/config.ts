import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isRecord, resolveProfile } from './generator-api.js';
import { defaultModelOutput } from './generated-paths.js';
import type {
  GolemProfile,
  ControllerContext,
  ControllerTag,
  ControllerUriVersioning,
  GeneratorJobContext,
  InputObserver,
  ModelContext,
  OpenApiContext,
} from './generator-api.js';

export type GolemJob =
  | { readonly id: string; readonly kind: 'controllers'; readonly package: '@exprtlabs/golem-ts-openapi'; readonly options: ControllerContext }
  | { readonly id: string; readonly kind: 'openapi'; readonly package: '@exprtlabs/golem-openapi'; readonly options: OpenApiContext }
  | { readonly id: string; readonly kind: 'models'; readonly package: '@exprtlabs/golem-model'; readonly options: ModelContext }
  | { readonly id: string; readonly kind: 'generator'; readonly package: string; readonly options: GeneratorJobContext };

export interface GolemConfig {
  readonly configFile: string;
  readonly directory: string;
  /** The project's tsconfig: where `golem generate` and `golem build` start. Its directory is the project root a rewrite names files from. A tsconfig the yaml names exists; the default beside the yaml need not. */
  readonly tsconfig: string;
  readonly profile: GolemProfile;
  readonly jobs: readonly GolemJob[];
  readonly inventoryFile: string;
}

/** The job section that runs each built-in package; a `generators` entry names a third-party package instead. */
const BUILT_IN_JOB_SECTIONS: Readonly<Record<string, string>> = {
  '@exprtlabs/golem-model': 'models',
  '@exprtlabs/golem-openapi': 'openapi',
  '@exprtlabs/golem-ts-openapi': 'controllers',
};

function keys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} key: ${key}.`);
  }
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

/** The `suffixes` of a job: file-name endings that start with `.`, end in `.ts`, `.mts` or `.cts`, never repeat and never name a generated file. */
function suffixes(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a nonempty array.`);
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !entry.startsWith('.') || !/\.[cm]?ts$/.test(entry)) {
      throw new Error(`${label}[${index}] must be a string that starts with "." and ends in .ts, .mts or .cts.`);
    }
    if (/\.generated\.[cm]?ts$/.test(entry)) throw new Error(`${label}[${index}] must not end in .generated.ts, .generated.mts or .generated.cts: golem writes those files.`);
    if (seen.has(entry)) throw new Error(`${label} lists ${entry} twice.`);
    seen.add(entry);
  }
  return value;
}

function positive(value: unknown, fallback: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return result;
}

function existing(filename: string, kind: 'directory' | 'file', label: string): void {
  let stat: fs.Stats;
  try { stat = fs.statSync(filename); } catch { throw new Error(`${label} does not exist: ${filename}`); }
  if (!(kind === 'directory' ? stat.isDirectory() : stat.isFile())) throw new Error(`${label} must be a ${kind}: ${filename}`);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function recordArray(value: unknown, label: string): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of objects.`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function recordMap(value: unknown, label: string): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(record(value, label)).map(([name, item]) => [
    name,
    record(item, `${label}.${name}`),
  ] as const);
  return Object.fromEntries(entries);
}

function controllerTags(value: unknown, label: string): readonly ControllerTag[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of tag objects.`);
  return value.map((item, index) => {
    const tag = record(item, `${label}[${index}]`);
    if (typeof tag.name !== 'string' || !tag.name.trim()) {
      throw new TypeError(`${label}[${index}].name must be a nonempty string.`);
    }
    return tag as ControllerTag;
  });
}

function controllerUriVersioning(value: unknown, label: string): ControllerUriVersioning | undefined {
  if (value === undefined) return undefined;
  const options = record(value, label);
  keys(options, ['type', 'prefix', 'defaultVersion'], label);
  const type = options.type;
  if (type !== undefined && type !== 'URI' && type !== 'uri' && type !== 0) {
    throw new TypeError(`${label}.type must be URI or 0.`);
  }
  const prefix = optionalString(options.prefix, `${label}.prefix`);
  const defaultVersion = options.defaultVersion;
  if (defaultVersion !== undefined
    && typeof defaultVersion !== 'string'
    && !(Array.isArray(defaultVersion) && defaultVersion.every(item => typeof item === 'string' && item.length > 0))) {
    throw new TypeError(`${label}.defaultVersion must be a string or a nonempty string array.`);
  }
  return {
    ...(type === undefined ? {} : { type }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(defaultVersion === undefined ? {} : { defaultVersion }),
  } as ControllerUriVersioning;
}

/**
 * Resolve a path through its existing prefix while retaining future path
 * components, so a symlinked ancestor cannot change a not-yet-created target.
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

/** A file's name under its canonical directory: a link to the file is not followed, so the file stays where it is named. */
export function canonicalFile(filename: string): string {
  const resolved = path.resolve(filename);
  return path.join(canonicalPath(path.dirname(resolved)), path.basename(resolved));
}

export function contains(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** The tsconfig the models and controllers analysis finds from a job root: the nearest `tsconfig.json` upward, as `tsc` does. */
function tsconfigFoundFrom(root: string): string | undefined {
  for (let directory = root; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'tsconfig.json');
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return canonicalFile(candidate);
    if (path.dirname(directory) === directory) return undefined;
  }
}

/**
 * One golem.yaml serves one tsconfig. The rewrite scan and the build read the tsconfig the yaml names, while the models and
 * controllers analysis still reads the one it finds from its job root, so a job must lie inside the yaml tsconfig's directory
 * and find that same file.
 */
function assertJobsMatchTsconfig(configFile: string, tsconfig: string, declared: boolean, jobs: readonly GolemJob[]): void {
  const directory = path.dirname(tsconfig);
  for (const job of jobs) {
    if (job.kind !== 'models' && job.kind !== 'controllers') continue;
    const { root } = job.options;
    if (!contains(directory, root)) throw new Error(`job root ${root} is outside ${directory}; use one golem.yaml per tsconfig.`);
    const found = tsconfigFoundFrom(root);
    if (found !== undefined && found !== tsconfig) {
      throw new Error(
        `${configFile} uses the tsconfig ${tsconfig}, but the ${job.id} job reads ${found}, the tsconfig it finds from its root ${root}. `
        + (declared
          ? "A non-default tsconfig: that differs from the job's own tsconfig is not supported yet; name the file the job finds."
          : "A default tsconfig.json that differs from the job's own tsconfig is not supported yet; name the file the job finds with tsconfig:."),
      );
    }
  }
}

/** Parse and resolve the complete dependency graph before checking existence. */
export function resolveConfig(filename = 'golem.yaml', onInput?: InputObserver): GolemConfig {
  const requested = path.resolve(filename);
  onInput?.(requested);
  const configFile = fs.realpathSync.native(requested);
  onInput?.(configFile);
  const directory = path.dirname(configFile);
  const value: unknown = YAML.parse(fs.readFileSync(configFile, 'utf8'), { uniqueKeys: true });
  keys(value, ['version', 'tsconfig', 'mobx', 'validation', 'allowAny', 'unknownFormats', 'generators', 'controllers', 'openapi', 'models'], 'configuration');
  if (value.version !== 1) throw new Error('Configuration version must be 1.');
  if (value.unknownFormats !== undefined && value.unknownFormats !== 'warn' && value.unknownFormats !== 'error') throw new Error('unknownFormats must be "warn" or "error".');
  const profile = resolveProfile({
    mobx: boolean(value.mobx, false, 'mobx'), validation: boolean(value.validation, true, 'validation'),
    allowAny: boolean(value.allowAny, false, 'allowAny'),
    ...(value.unknownFormats === undefined ? {} : { unknownFormats: value.unknownFormats }),
  });
  const tsconfigRequested = path.resolve(directory, value.tsconfig === undefined ? 'tsconfig.json' : nonempty(value.tsconfig, 'tsconfig'));
  onInput?.(tsconfigRequested);
  // The directory is canonical and the file keeps its name: a linked tsconfig.json belongs to the directory that holds the link.
  const tsconfig = canonicalFile(tsconfigRequested);
  onInput?.(tsconfig);
  const jobs: GolemJob[] = [];
  const outputs: string[] = [];
  const inputPath = (value: unknown, label: string): string => {
    const requested = path.resolve(directory, nonempty(value, label));
    onInput?.(requested);
    const resolved = canonicalPath(requested);
    onInput?.(resolved);
    return resolved;
  };
  // Generator jobs run first, so the built-in jobs read what they write.
  if (value.generators !== undefined) {
    if (!Array.isArray(value.generators) || !value.generators.length) throw new Error('generators must be a nonempty array of jobs.');
    for (const [index, entry] of value.generators.entries()) {
      const label = `generators[${index}]`;
      keys(entry, ['package', 'output', 'options'], label);
      const packageName = nonempty(entry.package, `${label}.package`);
      const section = BUILT_IN_JOB_SECTIONS[packageName];
      if (section) throw new Error(`${label}.package must be a third-party generator, but ${packageName} is built in. Configure it with the ${section} job instead.`);
      if (packageName === '@exprtlabs/golem') throw new Error(`${label}.package must be a third-party generator, but @exprtlabs/golem is the CLI, not a generator.`);
      const output = canonicalPath(path.resolve(directory, nonempty(entry.output, `${label}.output`)));
      if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new Error(`${label}.output must be a directory.`);
      for (const previous of outputs) {
        if (contains(previous, output) || contains(output, previous)) throw new Error(`Overlapping generated outputs: ${previous} and ${output}`);
      }
      outputs.push(output);
      jobs.push({ id: `generator:${path.relative(directory, output) || '.'}`, kind: 'generator', package: packageName, options: { directory, output, options: entry.options ?? {}, profile } });
    }
  }
  if (value.controllers !== undefined) {
    if (!Array.isArray(value.controllers) || !value.controllers.length) throw new Error('controllers must be a nonempty array of jobs.');
    for (const [index, entry] of value.controllers.entries()) {
      const label = `controllers[${index}]`;
      keys(entry, [
        'framework', 'root', 'sources', 'suffixes', 'output', 'openapiVersion', 'info', 'servers',
        'securitySchemes', 'tags', 'globalPrefix', 'uriVersioning',
      ], label);
      if (entry.framework !== undefined && entry.framework !== 'nestjs') throw new Error(`${label}.framework must be nestjs.`);
      const root = inputPath(entry.root ?? '.', `${label}.root`);
      const output = canonicalPath(path.resolve(directory, nonempty(entry.output, `${label}.output`)));
      if (!/\.(?:json|ya?ml)$/i.test(output)) throw new Error(`${label}.output must be a JSON or YAML file.`);
      if (fs.existsSync(output) && !fs.statSync(output).isFile()) throw new Error(`${label}.output must be a file.`);
      for (const previous of outputs) {
        if (contains(previous, output) || contains(output, previous)) throw new Error(`Overlapping generated outputs: ${previous} and ${output}`);
      }
      outputs.push(output);
      const sourceValues = entry.sources === undefined
        ? undefined
        : (() => {
          if (!Array.isArray(entry.sources) || !entry.sources.length) throw new Error(`${label}.sources must be a nonempty array.`);
          const sources = entry.sources.map(source => inputPath(source, `${label}.source`));
          if (new Set(sources).size !== sources.length) throw new Error(`Duplicate ${label}.sources paths.`);
          return sources;
        })();
      const sourceSuffixes = suffixes(entry.suffixes, `${label}.suffixes`);
      const openapiVersion = entry.openapiVersion === undefined ? '3.2.0' : entry.openapiVersion;
      if (openapiVersion !== '3.2.0' && openapiVersion !== '3.1.2') {
        throw new Error(`${label}.openapiVersion must be 3.2.0 or 3.1.2.`);
      }
      const info = record(entry.info, `${label}.info`);
      const servers = recordArray(entry.servers, `${label}.servers`);
      const securitySchemes = recordMap(entry.securitySchemes, `${label}.securitySchemes`);
      const tags = controllerTags(entry.tags, `${label}.tags`);
      const globalPrefix = optionalString(entry.globalPrefix, `${label}.globalPrefix`);
      const uriVersioning = controllerUriVersioning(entry.uriVersioning, `${label}.uriVersioning`);
      jobs.push({ id: `controllers:${path.relative(directory, output) || '.'}`, kind: 'controllers', package: '@exprtlabs/golem-ts-openapi', options: {
        root,
        output,
        profile,
        openapiVersion,
        info,
        ...(sourceValues ? { sources: sourceValues } : {}),
        ...(sourceSuffixes ? { suffixes: sourceSuffixes } : {}),
        ...(servers ? { servers } : {}),
        ...(securitySchemes ? { securitySchemes } : {}),
        ...(tags ? { tags } : {}),
        ...(globalPrefix === undefined ? {} : { globalPrefix }),
        ...(uriVersioning === undefined ? {} : { uriVersioning }),
      } });
    }
  }
  if (value.openapi !== undefined) {
    if (!Array.isArray(value.openapi) || !value.openapi.length) throw new Error('openapi must be a nonempty array of jobs.');
    for (const [index, entry] of value.openapi.entries()) {
      const label = `openapi[${index}]`;
      keys(entry, ['input', 'output', 'name', 'allowRemoteRefs', 'remoteHosts', 'maxRefBytes', 'maxRefDocuments', 'refTimeoutMs', 'dates'], label);
      const input = inputPath(entry.input, `${label}.input`);
      const output = canonicalPath(path.resolve(directory, nonempty(entry.output, `${label}.output`)));
      if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new Error(`${label}.output must be a directory.`);
      for (const previous of outputs) {
        if (contains(previous, output) || contains(output, previous)) throw new Error(`Overlapping OpenAPI outputs: ${previous} and ${output}`);
      }
      outputs.push(output);
      const allowRemoteRefs = boolean(entry.allowRemoteRefs, false, `${label}.allowRemoteRefs`);
      if (entry.remoteHosts !== undefined && !Array.isArray(entry.remoteHosts)) throw new Error(`${label}.remoteHosts must be an array of nonempty hostnames.`);
      const remoteHosts = (entry.remoteHosts ?? []).map((host: unknown) => nonempty(host, `${label}.remoteHosts`));
      if (allowRemoteRefs && !remoteHosts.length) throw new Error(`${label}.allowRemoteRefs requires remoteHosts.`);
      if (entry.dates !== undefined && entry.dates !== 'date' && entry.dates !== 'temporal') throw new Error(`${label}.dates must be "date" or "temporal".`);
      jobs.push({ id: `openapi:${path.relative(directory, output) || '.'}`, kind: 'openapi', package: '@exprtlabs/golem-openapi', options: {
        input, output, profile, allowRemoteRefs, remoteHosts,
        ...(entry.name === undefined ? {} : { name: nonempty(entry.name, `${label}.name`) }),
        ...(entry.dates === undefined ? {} : { dates: entry.dates }),
        maxRefBytes: positive(entry.maxRefBytes, 5 * 1024 * 1024, `${label}.maxRefBytes`),
        maxRefDocuments: positive(entry.maxRefDocuments, 256, `${label}.maxRefDocuments`),
        refTimeoutMs: positive(entry.refTimeoutMs, 10000, `${label}.refTimeoutMs`),
      } });
    }
  }
  if (value.models !== undefined) {
    keys(value.models, ['root', 'sources', 'suffixes', 'output'], 'models');
    const root = inputPath(value.models.root ?? '.', 'models.root');
    const output = canonicalPath(value.models.output === undefined
      ? defaultModelOutput(root)
      : path.resolve(directory, nonempty(value.models.output, 'models.output')));
    if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new Error('models.output must be a directory.');
    for (const previous of outputs) {
      if (contains(previous, output) || contains(output, previous)) throw new Error(`Overlapping generated outputs: ${previous} and ${output}`);
    }
    let sources: string[] | undefined;
    if (value.models.sources !== undefined) {
      if (!Array.isArray(value.models.sources) || !value.models.sources.length) throw new Error('models.sources must be a nonempty array.');
      sources = value.models.sources.map(source => inputPath(source, 'model source'));
      if (new Set(sources).size !== sources.length) throw new Error('Duplicate model source paths.');
    }
    const sourceSuffixes = suffixes(value.models.suffixes, 'models.suffixes');
    jobs.push({ id: `models:${path.relative(directory, root) || '.'}`, kind: 'models', package: '@exprtlabs/golem-model', options: { root, directory, output, profile, ...(sources ? { sources } : {}), ...(sourceSuffixes ? { suffixes: sourceSuffixes } : {}) } });
  }
  if (!jobs.length) throw new Error('Configure at least one generators, controllers, openapi, or models section.');
  // A misspelled path is that, not a tsconfig the jobs happen to find elsewhere.
  if (value.tsconfig !== undefined) existing(tsconfig, 'file', 'tsconfig');
  assertJobsMatchTsconfig(configFile, tsconfig, value.tsconfig !== undefined, jobs);
  for (const [index, job] of jobs.entries()) {
    const inputs = job.kind === 'openapi' ? [job.options.input] : job.kind === 'generator' ? [] : job.options.sources ?? [];
    for (const input of inputs) {
      for (const [producerIndex, producer] of jobs.entries()) {
        const output = producer.options.output;
        if (!output) continue;
        const owns = producer.kind === 'controllers' ? input === output : contains(output, input);
        if (owns && producerIndex >= index) throw new Error(`Generated input dependency cycle: ${job.id} reads ${input} from ${producer.id}.`);
      }
    }
  }
  return { configFile, directory, tsconfig, profile, jobs, inventoryFile: path.join(directory, '.golem', 'outputs.json') };
}

export function validateConfigInputs(config: GolemConfig): void {
  const controllerOutputs = new Set(config.jobs
    .filter((job): job is Extract<GolemJob, { kind: 'controllers' }> => job.kind === 'controllers')
    .map(job => canonicalPath(job.options.output)));
  for (const job of config.jobs) {
    if (job.kind === 'controllers') {
      existing(job.options.root, 'directory', 'controllers.root');
      for (const source of job.options.sources ?? []) existing(source, 'file', 'controller source');
      if (fs.existsSync(job.options.output) && !fs.statSync(job.options.output).isFile()) {
        throw new Error(`controllers.output must be a file: ${job.options.output}`);
      }
    } else if (job.kind === 'openapi') {
      // A controller job is the declared upstream producer for its exact OAS file.
      // It is intentionally allowed to be absent until the controller runs.
      if (!controllerOutputs.has(canonicalPath(job.options.input))) existing(job.options.input, 'file', 'OpenAPI input');
    } else if (job.kind === 'models') {
      existing(job.options.root, 'directory', 'models.root');
      for (const source of job.options.sources ?? []) existing(source, 'file', 'model source');
    }
  }
}

export function loadConfig(filename = 'golem.yaml', onInput?: InputObserver): GolemConfig {
  const config = resolveConfig(filename, onInput);
  validateConfigInputs(config);
  return config;
}
