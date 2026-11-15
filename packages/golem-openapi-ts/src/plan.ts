// The plan entry of golem-openapi-ts (`golem.plan`): it reads the `openapi-ts` block of golem.yaml and declares one job for each entry of `sdks`. It is light: it imports no TypeScript, no yaml and no generator code.
import fs from 'node:fs';
import path from 'node:path';
import type { Code } from '@exprtlabs/golem/internal/emitter';
import type { GolemDiagnostic, GolemPlanEntry, InputObserver, JobFacts, GolemProfile, PlanContext, PlannedJob } from '@exprtlabs/golem/generator-api';
import { canonicalPath, CODECS_HOST, isRecord, nonempty, sdkCodecsFile } from '@exprtlabs/golem/internal/plan-support';
import { REFERENCE_LIMIT_DEFAULTS } from './reference-limits.js';

export interface OpenApiContext {
  readonly input: string;
  readonly output: string;
  readonly name?: string;
  readonly remoteHosts?: readonly string[];
  readonly maxRefBytes?: number;
  readonly maxRefDocuments?: number;
  readonly refTimeoutMs?: number;
  /** `temporal` maps `format: date-time`, `date` and `duration` to Temporal types; the default is `date`. */
  readonly dates?: 'date' | 'temporal';
  /** `standalone` (the default) is an SDK that needs no models job; `golem` leaves validators and conversion to the models job of the same golem.yaml. */
  readonly mode?: OpenApiModeKind;
  /** Mode `golem` only: the absolute path of the file the models job writes for this SDK and the operation modules import (`sdkCodecsFile`). The config sets it. */
  readonly codecsFile?: string;
  readonly profile: GolemProfile;
  readonly onInput?: InputObserver;
}

/** What the generator receives: the context of an SDK job without what the host adds. */
export type OpenApiOptions = Omit<OpenApiContext, 'onInput'>;

/** The mode of an SDK job after `resolveOpenApiMode`: a golem SDK always holds the file it imports its codecs from, and a standalone SDK holds none. */
export type OpenApiMode = { readonly kind: 'standalone' } | { readonly kind: 'golem'; readonly codecsFile: string };
export type OpenApiModeKind = OpenApiMode['kind'];

/** The `mode` and `codecsFile` that a job context or a caller of `writeSdk` sets; the generator resolves them once, at its entry. */
export interface OpenApiModeSetting {
  readonly mode?: OpenApiModeKind | undefined;
  readonly codecsFile?: string | undefined;
}

export const OPENAPI_DATES = ['date', 'temporal'] as const;
const OPENAPI_MODES = ['standalone', 'golem'] as const;

/** The one place that checks an option that holds one of a closed set of words, for a job of `golem.yaml` and for a caller of the generator: the value of the set, `undefined` when it is not set, and a `TypeError` that names `where` for any other value. */
export function optionChoice<Choice extends string>(value: unknown, allowed: readonly Choice[], where: string): Choice | undefined {
  if (value === undefined) return undefined;
  const choice = allowed.find((item) => item === value);
  if (choice === undefined) throw new TypeError(`${where} must be ${allowed.map((item) => JSON.stringify(item)).join(' or ')} when provided`);
  return choice;
}

/** The one place that checks the mode and its codecs file. A value a JavaScript caller passes is checked here, so the generator behind it reads a mode that holds what it needs. */
export function resolveOpenApiMode({ mode, codecsFile }: OpenApiModeSetting): OpenApiMode {
  switch (optionChoice(mode, OPENAPI_MODES, 'context.mode')) {
    case undefined:
    case 'standalone':
      return { kind: 'standalone' };
    case 'golem':
      if (typeof codecsFile !== 'string' || !path.isAbsolute(codecsFile)) throw new TypeError('context.codecsFile must be an absolute path when mode is "golem"');
      return { kind: 'golem', codecsFile };
  }
}

/** The hook where an extension wraps the operations that an SDK job emits. Its participant type belongs to this package. */
export const OPERATION_WRAPPER_HOOK = 'client.operationWrapper';

/** What an extension on `client.operationWrapper` makes of the operations: the type each operation function returns and the function that creates it. */
export interface OperationWrapper {
  readonly operationType: Code;
  readonly createOperation: Code;
}

/** The answer of a participant of `OPERATION_WRAPPER_HOOK`: the wrapper, or the diagnostic that stops the job for the mode it was asked about. */
export type OperationWrapperResult = { readonly wrapper: OperationWrapper } | { readonly diagnostic: GolemDiagnostic };

/** The participant of `OPERATION_WRAPPER_HOOK`. It takes the mode of the SDK job. At most one extension fills the hook. */
export type OperationWrapperParticipant = (mode: OpenApiModeKind) => OperationWrapperResult;

const BLOCK_KEYS: readonly string[] = ['sdks', 'extensions'];
const SDK_KEYS: readonly string[] = ['input', 'output', 'name', 'remoteHosts', 'maxRefBytes', 'maxRefDocuments', 'refTimeoutMs', 'dates', 'mode'];

function keys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} key: ${key}.`);
  }
}

function positive(value: unknown, fallback: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return result;
}

/** The `sdks` list of the block: nothing when the block lists none, else a nonempty array. */
function sdksOf(block: unknown): readonly unknown[] {
  if (block === undefined || block === null) return [];
  keys(block, BLOCK_KEYS, 'openapi-ts');
  if (block.sdks === undefined) return [];
  if (!Array.isArray(block.sdks) || !block.sdks.length) throw new Error('openapi-ts.sdks must be a nonempty array of jobs.');
  return block.sdks;
}

/** A `remoteHosts` entry: a host with an optional port, and nothing else. A path or a scheme would name more or less than the entry reads. */
function remoteHost(entry: string, label: string): string {
  let url: URL | undefined;
  try { url = new URL(`https://${entry}`); } catch { url = undefined; }
  if (url === undefined || `${url.pathname}${url.search}${url.hash}` !== '/' || url.username || url.password || entry.endsWith('/')) throw new Error(`${label} entry "${entry}" must be a host with an optional port, such as schemas.example:8443.`);
  return entry;
}

/** The settings of the extensions the block turns on. Core has checked that each name is registered; the package checks what each holds. */
function checkExtensions(block: unknown): void {
  if (!isRecord(block) || block.extensions === undefined) return;
  if (!isRecord(block.extensions)) throw new TypeError('openapi-ts.extensions must be an object.');
  const mobx = block.extensions.mobx;
  if (mobx !== undefined && mobx !== null) keys(mobx, [], 'openapi-ts.extensions.mobx');
}

export const plan: GolemPlanEntry<OpenApiOptions> = {
  declare({ directory, profile, block, onInput }: PlanContext): readonly PlannedJob<OpenApiOptions>[] {
    checkExtensions(block);
    return sdksOf(block).map((entry, index): PlannedJob<OpenApiOptions> => {
      const label = `openapi-ts.sdks[${index}]`;
      keys(entry, SDK_KEYS, label);
      const requested = path.resolve(directory, nonempty(entry.input, `${label}.input`));
      onInput?.(requested);
      const input = canonicalPath(requested);
      onInput?.(input);
      const output = canonicalPath(path.resolve(directory, nonempty(entry.output, `${label}.output`)));
      if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new Error(`${label}.output must be a directory.`);
      if (entry.remoteHosts !== undefined && !Array.isArray(entry.remoteHosts)) throw new Error(`${label}.remoteHosts must be an array of nonempty hostnames.`);
      const remoteHosts = (entry.remoteHosts ?? []).map((host: unknown) => remoteHost(nonempty(host, `${label}.remoteHosts`), `${label}.remoteHosts`));
      const dates = optionChoice(entry.dates, OPENAPI_DATES, `${label}.dates`);
      const mode = optionChoice(entry.mode, OPENAPI_MODES, `${label}.mode`) ?? 'standalone';
      const options: OpenApiOptions = {
        input, output, profile, remoteHosts, mode,
        ...(entry.name === undefined ? {} : { name: nonempty(entry.name, `${label}.name`) }),
        ...(dates === undefined ? {} : { dates }),
        maxRefBytes: positive(entry.maxRefBytes, REFERENCE_LIMIT_DEFAULTS.maxRefBytes, `${label}.maxRefBytes`),
        maxRefDocuments: positive(entry.maxRefDocuments, REFERENCE_LIMIT_DEFAULTS.maxRefDocuments, `${label}.maxRefDocuments`),
        refTimeoutMs: positive(entry.refTimeoutMs, REFERENCE_LIMIT_DEFAULTS.refTimeoutMs, `${label}.refTimeoutMs`),
      };
      const facts: JobFacts = {
        id: `openapi:${path.relative(directory, output) || '.'}`,
        outputs: [{ path: output, kind: 'folder' }],
        ownedRoots: [],
        inputFiles: [input],
        inputFolders: [],
        readsProgram: false,
        provides: [],
        // A golem SDK imports the codecs file that the host of the codecs writes for it.
        needs: mode === 'golem' ? [CODECS_HOST] : [],
        hooks: [OPERATION_WRAPPER_HOOK],
        watch: [],
      };
      return { facts, options };
    });
  },

  /** A golem SDK imports the file that the codecs host writes for it; the job writes only the import. */
  link(job, { needed }) {
    const host = needed[CODECS_HOST];
    if (host === undefined) return job;
    return { facts: job.facts, options: { ...job.options, codecsFile: sdkCodecsFile({ ...host, sdkOutput: job.options.output }) } };
  },
};
