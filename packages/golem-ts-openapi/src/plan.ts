// The plan entry of the ts-openapi block (`golem.plan`). Core loads it when it reads golem.yaml, so it imports no TypeScript, no yaml and no generator code.
import path from 'node:path';
import { canonicalPath, checkedSuffixes, isRecord, MODEL_BOUNDARY } from '@exprtlabs/golem/internal/plan-support';
import type {
  ControllerContext,
  ControllerTag,
  ControllerUriVersioning,
  GolemPlanEntry,
  InputObserver,
  PlanContext,
  PlannedJob,
} from '@exprtlabs/golem/generator-api';

/** File-name endings that make a file below `root/src` a controller source when a docs job sets none. */
export const DEFAULT_CONTROLLER_SUFFIXES: readonly string[] = ['.controller.ts'];

const BLOCK = 'ts-openapi';
const DOCS_KEYS: readonly string[] = [
  'framework', 'root', 'sources', 'suffixes', 'output', 'openapiVersion', 'info', 'servers',
  'securitySchemes', 'tags', 'globalPrefix', 'uriVersioning', 'maxResultBytes',
];

function keys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} key: ${key}.`);
  }
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
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
  const entries = Object.entries(record(value, label)).map(([name, item]) => [name, record(item, `${label}.${name}`)] as const);
  return Object.fromEntries(entries);
}

function controllerTags(value: unknown, label: string): readonly ControllerTag[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of tag objects.`);
  return value.map((item, index) => {
    const tag = record(item, `${label}[${index}]`);
    if (typeof tag.name !== 'string' || !tag.name.trim()) throw new TypeError(`${label}[${index}].name must be a nonempty string.`);
    return tag as ControllerTag;
  });
}

function controllerUriVersioning(value: unknown, label: string): ControllerUriVersioning | undefined {
  if (value === undefined) return undefined;
  const options = record(value, label);
  keys(options, ['type', 'prefix', 'defaultVersion'], label);
  const type = options.type;
  if (type !== undefined && type !== 'URI' && type !== 'uri' && type !== 0) throw new TypeError(`${label}.type must be URI or 0.`);
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

/** A path the block names, made absolute from the golem.yaml folder and canonical. The observer sees it as written and as resolved, before the job reads it. */
function inputPath(directory: string, onInput: InputObserver | undefined, value: unknown, label: string): string {
  const requested = path.resolve(directory, nonempty(value, label));
  onInput?.(requested);
  const resolved = canonicalPath(requested);
  onInput?.(resolved);
  return resolved;
}

/** One docs job of the block: the document it writes, the sources it reads and the options its generator receives. */
function docsJob(context: PlanContext, entry: unknown, label: string): PlannedJob<ControllerContext> {
  const { directory, onInput } = context;
  keys(entry, DOCS_KEYS, label);
  if (entry.framework !== undefined && entry.framework !== 'nestjs') throw new Error(`${label}.framework must be nestjs.`);
  const root = inputPath(directory, onInput, entry.root ?? '.', `${label}.root`);
  const output = canonicalPath(path.resolve(directory, nonempty(entry.output, `${label}.output`)));
  if (!/\.(?:json|ya?ml)$/i.test(output)) throw new Error(`${label}.output must be a JSON or YAML file.`);
  let sources: string[] | undefined;
  if (entry.sources !== undefined) {
    if (!Array.isArray(entry.sources) || !entry.sources.length) throw new Error(`${label}.sources must be a nonempty array.`);
    sources = entry.sources.map(source => inputPath(directory, onInput, source, `${label}.source`));
    if (new Set(sources).size !== sources.length) throw new Error(`Duplicate ${label}.sources paths.`);
  }
  const sourceSuffixes = checkedSuffixes(entry.suffixes, `${label}.suffixes`);
  const openapiVersion = entry.openapiVersion === undefined ? '3.2.0' : entry.openapiVersion;
  if (openapiVersion !== '3.2.0' && openapiVersion !== '3.1.2') throw new Error(`${label}.openapiVersion must be 3.2.0 or 3.1.2.`);
  const info = record(entry.info, `${label}.info`);
  const servers = recordArray(entry.servers, `${label}.servers`);
  const securitySchemes = recordMap(entry.securitySchemes, `${label}.securitySchemes`);
  const tags = controllerTags(entry.tags, `${label}.tags`);
  const globalPrefix = optionalString(entry.globalPrefix, `${label}.globalPrefix`);
  const uriVersioning = controllerUriVersioning(entry.uriVersioning, `${label}.uriVersioning`);
  const maxResultBytes = entry.maxResultBytes === undefined ? undefined : positive(entry.maxResultBytes, `${label}.maxResultBytes`);
  const id = `docs:${path.relative(directory, output)}`;
  return {
    facts: {
      id,
      outputs: [{ path: output, kind: 'file' }],
      ownedRoots: [],
      scanRoots: [root],
      inputFiles: sources ?? [],
      inputFolders: [],
      readsProgram: true,
      provides: [],
      needs: [],
      wants: [MODEL_BOUNDARY],
      hooks: [],
      // A job with a list of sources reads those and no others. Otherwise a file below `src` of the root with a controller ending is a source, whether or not a run has read it.
      watch: sources ? [] : [{ folder: path.join(root, 'src'), suffixes: sourceSuffixes ?? DEFAULT_CONTROLLER_SUFFIXES }],
    },
    options: {
      root,
      output,
      tsconfig: context.tsconfig,
      profile: context.profile,
      ...(context.exact === undefined ? {} : { exact: context.exact }),
      openapiVersion,
      info,
      ...(sources ? { sources } : {}),
      ...(sourceSuffixes ? { suffixes: sourceSuffixes } : {}),
      ...(servers ? { servers } : {}),
      ...(securitySchemes ? { securitySchemes } : {}),
      ...(tags ? { tags } : {}),
      ...(globalPrefix === undefined ? {} : { globalPrefix }),
      ...(uriVersioning === undefined ? {} : { uriVersioning }),
      ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
    },
  };
}

export const plan: GolemPlanEntry<ControllerContext> = {
  declare(context) {
    keys(context.block, ['docs'], BLOCK);
    const { docs } = context.block;
    if (!Array.isArray(docs) || !docs.length) throw new Error(`${BLOCK}.docs must be a nonempty array of jobs.`);
    return docs.map((entry: unknown, index) => docsJob(context, entry, `${BLOCK}.docs[${index}]`));
  },
  // The second pass, when a job provides ModelBoundary: a controller type that is a shared model of the app is matched to its model through the boundary of the ModelBoundary provider.
  link(job, { needed }) {
    const { ModelBoundary: models } = needed;
    return { facts: job.facts, options: { ...job.options, ...(models ? { models } : {}) } };
  },
};
