import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isRecord, resolveProfile } from './generator-api.js';
import { defaultModelOutput } from './generated-paths.js';
import type {
  CodegenProfile,
  ControllerContext,
  ControllerTag,
  ControllerUriVersioning,
  InputObserver,
  ModelContext,
  OpenApiContext,
} from './generator-api.js';

export type CodegenJob =
  | { readonly id: string; readonly kind: 'controllers'; readonly package: '@exprtlabs/golem-ts-openapi'; readonly options: ControllerContext }
  | { readonly id: string; readonly kind: 'openapi'; readonly package: '@exprtlabs/golem-openapi'; readonly options: OpenApiContext }
  | { readonly id: string; readonly kind: 'models'; readonly package: '@exprtlabs/golem-model'; readonly options: ModelContext };

export interface CodegenConfig {
  readonly configFile: string;
  readonly directory: string;
  readonly profile: CodegenProfile;
  readonly jobs: readonly CodegenJob[];
  readonly inventoryFile: string;
}

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
  return path.join(fs.realpathSync(ancestor), ...missing);
}

export function contains(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Parse and resolve the complete dependency graph before checking existence. */
export function resolveConfig(filename = 'golem.yaml', onInput?: InputObserver): CodegenConfig {
  const requested = path.resolve(filename);
  onInput?.(requested);
  const configFile = fs.realpathSync(requested);
  onInput?.(configFile);
  const directory = path.dirname(configFile);
  const value: unknown = YAML.parse(fs.readFileSync(configFile, 'utf8'), { uniqueKeys: true });
  keys(value, ['version', 'mobx', 'validation', 'ajvStandalone', 'allowAny', 'controllers', 'openapi', 'models'], 'configuration');
  if (value.version !== 1) throw new Error('Configuration version must be 1.');
  const profile = resolveProfile({
    mobx: boolean(value.mobx, false, 'mobx'), validation: boolean(value.validation, true, 'validation'),
    ajvStandalone: boolean(value.ajvStandalone, false, 'ajvStandalone'), allowAny: boolean(value.allowAny, false, 'allowAny'),
  });
  const jobs: CodegenJob[] = [];
  const outputs: string[] = [];
  const inputPath = (value: unknown, label: string): string => {
    const requested = path.resolve(directory, nonempty(value, label));
    onInput?.(requested);
    const resolved = canonicalPath(requested);
    onInput?.(resolved);
    return resolved;
  };
  if (value.controllers !== undefined) {
    if (!Array.isArray(value.controllers) || !value.controllers.length) throw new Error('controllers must be a nonempty array of jobs.');
    for (const [index, entry] of value.controllers.entries()) {
      const label = `controllers[${index}]`;
      keys(entry, [
        'framework', 'root', 'sources', 'output', 'openapiVersion', 'info', 'servers',
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
      keys(entry, ['input', 'output', 'name', 'allowRemoteRefs', 'remoteHosts', 'maxRefBytes', 'maxRefDocuments', 'refTimeoutMs'], label);
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
      jobs.push({ id: `openapi:${path.relative(directory, output) || '.'}`, kind: 'openapi', package: '@exprtlabs/golem-openapi', options: {
        input, output, profile, allowRemoteRefs, remoteHosts,
        ...(entry.name === undefined ? {} : { name: nonempty(entry.name, `${label}.name`) }),
        maxRefBytes: positive(entry.maxRefBytes, 5 * 1024 * 1024, `${label}.maxRefBytes`),
        maxRefDocuments: positive(entry.maxRefDocuments, 256, `${label}.maxRefDocuments`),
        refTimeoutMs: positive(entry.refTimeoutMs, 10000, `${label}.refTimeoutMs`),
      } });
    }
  }
  if (value.models !== undefined) {
    keys(value.models, ['root', 'sources', 'output'], 'models');
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
    jobs.push({ id: `models:${path.relative(directory, root) || '.'}`, kind: 'models', package: '@exprtlabs/golem-model', options: { root, output, profile, ...(sources ? { sources } : {}) } });
  }
  if (!jobs.length) throw new Error('Configure at least one controllers, openapi, or models section.');
  for (const [index, job] of jobs.entries()) {
    const inputs = job.kind === 'openapi' ? [job.options.input] : job.options.sources ?? [];
    for (const input of inputs) {
      for (const [producerIndex, producer] of jobs.entries()) {
        const output = producer.options.output;
        if (!output) continue;
        const owns = producer.kind === 'controllers' ? input === output : contains(output, input);
        if (owns && producerIndex >= index) throw new Error(`Generated input dependency cycle: ${job.id} reads ${input} from ${producer.id}.`);
      }
    }
  }
  return { configFile, directory, profile, jobs, inventoryFile: path.join(directory, '.golem', 'outputs.json') };
}

export function validateConfigInputs(config: CodegenConfig): void {
  const controllerOutputs = new Set(config.jobs
    .filter((job): job is Extract<CodegenJob, { kind: 'controllers' }> => job.kind === 'controllers')
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
    } else {
      existing(job.options.root, 'directory', 'models.root');
      for (const source of job.options.sources ?? []) existing(source, 'file', 'model source');
    }
  }
}

export function loadConfig(filename = 'golem.yaml', onInput?: InputObserver): CodegenConfig {
  const config = resolveConfig(filename, onInput);
  validateConfigInputs(config);
  return config;
}
